# WDA 测试诊断日志

日志时间统一 UTC；北京时间减 8 小时可直接对照。网关 `ws_opened` 记录 session ID 与 namespace 的对应关系，原生日志位于 `RUNTIME_DIR/data/<namespace>/logs/`（实际以网关的 namespace 和部署数据路径为准）。原生进程启动/退出日志包含 namespace、PID 和退出状态。

## 留存与性能

- `daemon.log` 保留设备状态、每次健康失败耗时/累计失败状态，以及 WDA 重启原因。
- `daemon.stderr.log` 保留 WDA HTTP 阶段、XCTest 生命周期和 TCP 元数据；`daemon.stdout.log` 保留原生 daemon stdout。setup 输入/输出不经过此记录器。
- stdout/stderr 各自当前文件 32 MiB，另保留 `.1` 到 `.7`，每个流最多 256 MiB。目录权限 0700、当前文件 0600。
- pipe reader 与磁盘写入之间使用 1 MiB 有界队列。慢盘、磁盘失败不会阻塞手机链路；溢出时丢弃诊断数据，并输出 `native_log_overflow`、`native_log_dropped` 和累计丢弃字节数。写入失败报告 `native_log_disabled`。这些标记意味着时间段内证据不完整。
- 保持文件句柄，64 KiB 缓冲，至少每秒 flush；轮转及正常 pipe EOF 前 flush。进程突然崩溃可能损失最后一段尚未 flush 的数据。

推荐测试过滤器：

```text
info,ictl_wda::http=debug,ictl_wda::runner=info,jktcp::adapter=trace,idevice=warn
```

不启用整个 idevice 的 debug/trace，不记录 WebSocket URL/query、访问令牌、配对包、请求正文或正常 XCTest 原始调试消息。WebSocket 协议错误只记录固定分类，不回显对端错误文本。

## 定位顺序

1. `ws_closed`：检查 browser_close、socket_error、hello_timeout、eof、protocol_error 或 cancel；writer 日志进一步说明 heartbeat_pong_missing/send timeout/socket send failed。两者通过 session ID 关联。
2. `wda_health_failed`：查看 `stage=pool/probe/connect/write/flush/read`、耗时及是否复用 HTTP 连接。三次失败触发 `wda_restart`，重启策略未改变。
3. `xctest_exited` / `xctest_stop_requested`：区分 XCTest 自行退出与 supervisor 主动停止，结合运行时长和退出原因。
4. `tunnel_write_backpressure`：底层写入 Pending 持续至少一秒时报告，含包队列、当前写入偏移及连接数；恢复时记录 `tunnel_write_recovered` 和阻塞时长。TRACE 包仅含序号、ACK、窗口和长度等元数据，不含载荷。
5. 检查日志丢弃标记和轮转边界；日志缺失不能解释为没有发生错误。

## 合并 PR #8 后的流级诊断

以 `codex/fix-iphone-transport-stability` 为基线，吸收 PR #8 的关闭通知延迟补发与 IO 错误详情。保留基线的 SDK 生命周期/流控补丁和非阻塞日志记录器；不再叠加 PR #8 的 Vite transform，否则补丁锚点会失配。`UnexpectedEof: early eof` 等底层错误现在能出现在设备错误详情中。

网关日志用 `session` 关联浏览器连接，用 `stream` + `port` 区分同一会话的通道。namespace 对应原生进程日志目录；先通过 `ws_opened` 找到映射。流 ID 仅在对应 session 内有效。关键事件如下：

| 事件 | 含义 |
| --- | --- |
| `relay_stream_open_requested` | 开始请求手机端口 |
| `relay_stream_opened` | 手机接受连接；`elapsed_ms` 为本次打开耗时 |
| `relay_stream_retired` | 本地移除流；区分 `open_timeout`、`device_refused`、`local_eof`、`local_write_failed`、`local_read_failed`、`outbound_send_failed`、`peer_close`、`session_closed` 等原因 |
| `relay_stream_closed` | 接收字节数/帧数超限或消费者退出；只关闭该流，保留原因及当时队列容量 |
| `relay_close_deferred` | 关闭通知遇到出站队列暂满，后台补发，当前会话继续运行 |
| `relay_close_enqueued` | 关闭通知已进入 WebSocket 发送队列；`queue_recovered` 表示延迟恢复，附 `wait_ms`；这不代表手机已收到通知 |
| `relay_close_abandoned` | 等待补发期间整个会话已取消，无需再发通知 |
| `relay_cancel_requested` | 队列已关闭，或关闭通知等待 20 秒仍未入队，取消会话；区分 `outbound_queue_closed`、`close_queue_closed`、`close_delivery_timeout` |

打开结果与移除日志包含生命周期耗时、累计 `received_bytes`（浏览器到网关成功接收入队）、`sent_bytes`（网关到浏览器成功进入 WebSocket 队列）、当前接收积压和队列剩余帧容量。计数表示软件队列接受的数据，不表示手机或远端应用已经消费。正常数据包不逐条打印新增日志。

浏览器每秒通过已有独立诊断请求上报 `browser_transport`。新增流级字段：

- `sendSeq` / `peerAck` / `inFlightBytes`：32 位序号及未确认字节数，按回绕计算。
- `peerWindowBytes` / `availableWindowBytes`：手机通告窗口及扣除未确认数据后的可发送余量。
- `windowBlocked` / `windowBlockedMs`：应用仍有待发数据且窗口余量为零，以及从首次观测起的持续时长。
- `peerAckUnchangedMs`：有待发数据时，ACK 从首次观测起未推进的时长。
- `writeWaiters` / `ackPending` / `readQueuedFrames`：等窗口的写任务、待发送/发送中的 ACK、接收缓存帧数。
- 顶层 `usbSessionClosed` / `wsReadyState`：USB 会话关闭状态和浏览器 WebSocket 状态（0 连接中、1 已连接、2 关闭中、3 已关闭）。

时长均为采样观测值，精度受一秒采样、后台标签页节流和上传跳过影响；两个采样之间的恢复再阻塞无法识别，不应当作精确的协议超时计时器。新增字段仍只接受数字，不接收日志正文、设备报文或任意错误字符串。浏览器资源和网关应一起更新。

故障时可按以下顺序归档、对照：

1. 保留故障前后网关日志和对应 namespace 的 `daemon.log`、`daemon.stderr.log*`、`daemon.stdout.log*`，先找最早的失败事件，而非只看最后一次重启。
2. `windowBlocked=1` 且 `peerAckUnchangedMs` 持续增长：手机没有释放发送信用；对照端口和该流关闭/重置时间。
3. 有待发数据、`availableWindowBytes>0`，但 `usbWritePendingMs` 和 `pendingMuxWrites` 增长：更像物理 USB 写入阻塞；若 `ackPending=1`，说明 ACK 也可能排在 USB 写入之后。
4. `usbReadPendingMs` 单独增加也可能只是手机暂时没有数据，不能单独判定故障。需结合待发数据、ACK、健康检查和 USB 错误计数。
5. 出现 `relay_close_deferred` 后应有入队恢复、会话取消或超时结果；只有 `relay_cancel_requested` 才表示此路径主动结束会话。

容量是文件大小限制，不保证固定小时数。TRACE 流量随预览和操作频率变化；测试结束应及时归档本次 namespace 的事件日志、诊断日志和网关日志。
