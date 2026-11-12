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

## 手机 XCTest / WDA 生命周期

过去 UI 初始化、授权等待、bundle ready 和测试计划开始回调仅为 DEBUG；上述生产过滤器会过滤它们。此前部署留下的大量 TCP/HTTP 日志不能排除手机端反复授权或初始化，也不能把服务端 `xctest_started` 次数等同于手机界面出现次数。此改动不能补回历史缺失的回调。

现在以下固定事件以 INFO 写入 `daemon.stderr.log*`：

| 事件 | 含义 |
| --- | --- |
| `phone_diagnostics_enabled` | 原生程序已启用本组诊断；含 schema、native_pid 和覆盖标记 |
| `xctest_start_requested` / `xctest_started` | 本次启动请求 / 服务端 XCTest 任务开始 |
| `phone_process_launched` | 手机启动接口直接返回的 runner PID（`phone_pid`），授权随后失败也会保留 |
| `phone_process_observed` | DVT deviceinfo 对这个 PID 的查询结果；包含 running、not_running 或 unknown |
| `xctest_ui_initializing` | 手机报告 UI 测试初始化开始 |
| `xctest_authorization_wait` / `xctest_authorization_wait_ended` | 手机开始/结束 automation mode 等待；结束不代表授权成功，超时清理也会出现 |
| `xctest_bundle_ready` / `xctest_bundle_protocol_ready` / `xctest_runner_ready` | 手机测试包、协议和 runner 就绪回调 |
| `xctest_plan_started` / `xctest_plan_finished` | 手机测试计划开始/结束回调 |
| `xctest_ui_initialization_failed` / `xctest_bootstrap_failed` | 手机初始化/引导失败分类 |
| `xctest_http_ready` | 当前服务端 runner 的 WDA HTTP 就绪 |
| `xctest_exited` / `xctest_stop_requested` | 服务端任务结束 / 被主动停止 |

使用 namespace → `native_start_id` → `runner_id` 对照。`native_start_id` 是原生进程首次使用诊断时生成的 UUID；即使容器重建后 native_pid 和 runner_id 重复，也应按这个 UUID 分开。网关的 `ws_opened` 和 `native_started` 将 session、namespace、PID 与 namespace 下的原生日志关联起来；`phone_diagnostics_enabled` schema 3 和每个 runner 事件都带原生进程 UUID。一个原生进程内 runner_id 递增。

手机 PID 通过可选的同步 `ProcessObserver` 接口直接传递，不再解析 idevice 的 DEBUG 文字。未启用 observer 的 idevice 客户端保持原来的行为。格式器不再为了 PID 放开 idevice DEBUG；仍过滤 XCTest 的 INFO/DEBUG 原始消息，保留已有 WARN/ERROR 行为。回调带 `event_seq` 和累计初始化、授权等待、计划开始计数。`event_seq` 在一个 runner 内记录诊断事件顺序；退出汇总另记录收到的 phone log/debug 条数，不输出正文。

这些事件覆盖 XCTest 回调、启动返回值和定期 PID 查询。连接中断可能丢失回调；`xctest_exited` 的 socket/transport 分类只说明会话返回错误。查询明确返回 Boolean false 时，才有手机报告 PID 不在运行的证据。查询失败、超时、响应格式异常或功能未启用都记为 unknown。旧的 running 样本也不能证明进程在后续连接中断时仍然存活。现场判断仍须保留故障前后的日志，并确认样本的时间和年龄。

## 定位顺序

1. `ws_closed`：检查 browser_close、socket_error、hello_timeout、eof、protocol_error 或 cancel；writer 日志进一步说明 heartbeat_pong_missing/send_timeout/socket_send_failed。两者通过 session ID 关联。
2. `wda_health_failed`：查看 `stage=pool/probe/connect/write/flush/read`、耗时及是否复用 HTTP 连接。至少 3 次连续应答失败、首尾间隔达到 60 秒才触发存活 runner 的 `wda_restart`，重启策略未改变。
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

采样器必须包装真实 `USBDevice`，不能包装 `completeUsbPacketReads` 的代理。该代理的 `transferIn` 会继续调用真实设备；若通过代理安装采样函数，赋值会转发到真实设备，但读属性仍返回报文重组函数，形成递归，导致微任务持续排队、定时器和点击事件饥饿。浏览器客户端单独保留真实设备用于采样，SDK 保留完整报文代理；采样器也会检查赋值是否真正可见，忽略赋值的代理会立即恢复原函数并报告 hooked=0。回归用例同时验证碎片合并、物理读取计数、setup 请求完成及清理后函数恢复。

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

## 手机到 VPS 的上传拥塞保护

SDK 补丁 v6 补齐 phone → browser → VPS 方向的背压。`await WebSocket.send()` 不能表示数据已经传出；因此在调用原生 `send()` 前检查 `bufferedAmount + 本帧编码长度`。预览数据使用 128 KiB 上限，其他流数据使用 384 KiB 上限，协议消息使用 512 KiB 上限，为控制响应和心跳保留空间。这是浏览器 WebSocket 待发送字节预算，不包含操作系统 TCP 缓冲，不能解释为端到端延迟或总内存上限。

USB 每流最多保留 128 KiB 未转交 WebSocket 的数据，包含接收队列和上传 pump 正在等待发送的一块；同时限制为最多 64 条活动流。ACK 的接收窗口按剩余容量动态通告，消费后补发窗口更新；USB 接收/分流循环不等待 WebSocket，其他流的 ACK、关闭、控制消息继续处理。正常单字节零窗口探测保持 ACK 不动，等待恢复后重传；其他超过接收容量的情况明确重置该流，不静默截断字节。正常背压恢复、重传和 FIN 均保持字节顺序，不重放设备操作。

9100 端口预览等待上传空间持续 2 秒时，重置该预览连接，暂停新预览连接 30 秒；其他流保持连接。协议心跳发送不再阻塞入站消息处理。任何发送连续 20 秒无法获得空间时关闭整个 relay，避免永久保留等待任务；这不改变 WDA 健康检查的重启阈值。HTTP 预览可能跨 USB 重试保持打开，因此网页在连续画面超过 5 秒无新帧后释放预览订阅，改用既有截图轮询，并显示“截图预览（连续画面已暂停）”。首次加载也给予 5 秒等待时间。暂停后本页面保持截图模式，重新建立会话可再次尝试连续画面。

新增数值诊断字段：

- `uplinkWaiters` / `uplinkWaitCount` / `uplinkWaitMaxMs`：正在等待发送空间的任务数、累计等待次数、已结束等待的最长耗时。
- `previewPauses` / `previewCooldownMs`：因上传拥塞暂停预览的次数及剩余冷却时间。
- 每流 `readRetainedBytes` / `receiveWindowBytes`：尚未交给 WebSocket 的完整字节数，以及按 256 字节粒度通告的接收信用；`readQueuedBytes` 只统计接收队列，不含 pump 已取出的一块。

先对照 `wsBufferedBytes` 和 `uplinkWaiters`，再检查 9100 的 `readRetainedBytes` 是否有界、`receiveWindowBytes` 是否收缩/恢复，以及暂停后 WDA 请求是否恢复。预览关闭后网络仍无进展，应继续排查共享连接和实际带宽，不能据此认定 WDA 自身故障。

本次没有在任意 USB/TCP 数据块中丢帧，也没有改变转发协议；在浏览器上传前解析完整 MJPEG、保留最新 JPEG，以及独立媒体连接，仍属于后续架构改进。

验证覆盖真实 SDK 的慢上传、窗口关闭/恢复、单字节零窗口探测、编码帧头计入发送预算、控制/心跳继续处理、预览暂停和冷却、取消后不发送旧数据、FIN 最后数据排空、永久拥塞清理和 64 流上限。5 个最初的上传积压用例在 v5 上全部失败，在 v6 上通过；安装器验证 v1 至 v5 迁移、重复执行和拒绝被修改的包。浏览器测试还验证连续 HTTP 响应未关闭时切换截图，随后点按只派发一次。

本地 release 浏览器套件 183 项通过、48 项需要独立环境而跳过；独立真实网关接口回归 70 项通过（包含 64 流新字段接收），网关库 37 项通过，网关与 WASM 严格 Clippy、格式检查通过。`/iphone/` 生产路径的 release 浏览器启动通过，无未捕获异常。上述为合成环境，不代表真机慢网和长时间 WDA 稳定性已经验收。部署必须同时更新网关诊断接收字段与浏览器资源；旧网关会拒绝新增字段。

## 真机后续：单帧截图与显式停止预览

`7bcd6d2` 部署后，真机的浏览器上传积压被限制在约 384 KiB，页面也回退到了截图，但读取 `/screenshot` 仍有 30 秒超时。日志显示一次响应约 5.54 MB、解码后图片约 4.09 MB；已完成的读取耗时 16.5～29.7 秒。该次报错前只有状态、截图请求，没有点击或输入请求。队列有界不等于截图已经变快。

Appium WDA v16.15.3 的 `FBScreenshot.takeWithScreenID` 最终将图片转换为 PNG；`screenshotQuality=1` 只控制采集编码，不能据此假设普通截图接口会通过网络返回 JPEG。浏览器低延迟会话现在使用 9100 端口读取一帧 MJPEG 后关闭，复用已配置的 50% 缩放、40 JPEG 质量；普通客户端保留原始截图路径。捕获总期限 8 秒，HTTP/帧头各限 16 KiB，图片限 2 MiB，校验 JPEG 起止标记。失败时返回读取错误，不再自动启动大 PNG 下载。新事件 `mjpeg_capture` 只记录耗时、帧字节数及结果，不记录图片。

网页提供“暂停预览”按钮，手动或自动切换截图时同时发送鉴权的 `DELETE /preview/stream`，网关取消对应连续画面的生产任务、关闭 USB 连接和 HTTP 响应。不再仅依赖图片 src 改变后浏览器或代理及时取消 HTTP 请求。`preview_stopped` 记录该关闭；它不关闭设备会话、任务或单次截图。后续显式打开预览仍可创建新生产任务。回归覆盖鉴权、已有 HTTP 响应结束、USB StreamClose、重新打开预览，以及设备断开后的清理。读取截图的传输错误现在提示“暂时无法读取设备截图，请稍后刷新画面”，不再与已发出的控制操作结果未知共用提示；控制操作仍不自动重放。

这是设备原生程序、网关和网页的联合更新；旧原生程序仍会走 PNG，旧网页不会显式停止连续预览。

## 真机启动拒绝的 NSError 诊断

2026-11-11 北京时间 22:56 的新连接中，XCTest 任务在 10.7 秒后退出，手机进程启动服务返回 `NSCode=2` 的 NSError，但通用归档解码器只保留了 `NSDomain`/`NSUserInfo` 的 UID 引用，最终只显示 `unexpected response`。本次没有手机 PID 或初始化回调；同期 USB/WS 在线，不能据此认定已启动的 WDA 崩溃，也不能仅凭 code=2 判定开发者信任或签名问题。

现在 vendor 保留原上游 `89702099`，只在进程启动返回路径解析原始归档的 NSError：输出 domain、code、选定的本地化描述/失败原因以及 underlying error 链。新增 `phone_process_launch_failed` 包含 error_domain/error_code/error_depth，并继承 runner_id；解析出的有界错误链进入启动失败状态；schema 3 的 `xctest_exited` 只记录固定的退出分类。不会输出整个归档、未知 userInfo、启动环境或参数。解析上限为 256 KiB 归档、4096 个对象、16 次 UID 间接引用、8 层错误链、每段文本 512 字符、最终消息 2048 字符；循环和非法引用安全停止。没有改变成功 PID 的解释、启动策略或增加重试。

手动点开 WDA 后退出与服务端 XCTest 启动返回错误应分别记录；手动表现本身不足以确定拒绝启动的根因。实际原因必须重新发起一次受控启动，读到解码后的 domain/code/underlying error 后再判断。


## 按需采图与探活确认窗口（2026-11-12）

本节是当前策略，替代前文 v6 的自动预览及截图轮询行为。

- iPhone 网页连接或 WDA 恢复就绪后不再请求连续预览，也不启动后台截图轮询。每秒会话状态刷新不采图。用户点击“刷新屏幕”、手动控制后的核对、AI 任务自身观察仍按需截图；Android 保留既有截图刷新。
- 9100 仍用于读取单帧 JPEG，关闭实时画面不等于禁用截图服务。所有 9100 媒体保留 128 KiB WebSocket 额度，8100 控制/探活保留更大的额度；这只是共享链路的容量隔离，不会抢占已发送的数据或 WDA 内部正在执行的操作。
- SDK v7 仅在 `continuousPreviewEnabled=true` 时启用连续预览的 2 秒拥塞保护与 30 秒冷却。单帧不受旧冷却阻挡，持续拥塞 8 秒后只关闭该截图流；不关闭整个 relay，不设置后续截图冷却。显式停止预览成功后清除该标志与冷却。安装器验证 v1～v6 到 v7 的迁移和校验。
- `/status` 探活使用独立连接池，不等待普通 HTTP 请求占用的连接锁。建连上限 10 秒，应答阶段预算 5 秒，请求总上限 15 秒（含连接池等待及重试）；取消或失败连接不放回池。普通控制请求的时限和“不重放已发动作”规则保持不变。
- 连接、连接池等待或请求派发失败归类为 `transport_unavailable`，不累计为杀死存活 runner 的证据。至少 3 次连续应答失败、且首尾失败间隔达到 60 秒，才重启仍存活的 WDA；任一次探活成功或无法确认的传输故障清空该证据。真实 XCTest 退出继续立即进入原有恢复流程。这能减少短暂延迟触发的重启，不能证明 WDA 内部永不挂起；如果端口持续不可达而 XCTest 任务仍存活，本策略不会仅据此无限重启，需排查连接或重新连接设备。

每次健康失败写入 `event=wda_health_failed`，包括 `category`（`transport_unavailable` / `response_timeout` / `response_interrupted` / `response_error` / `not_ready`）、`consecutive_failures`、`failure_window_ms`、`confirm_window_ms`、`elapsed_ms`、`runner_alive` 和 `restart`。HTTP `http_budget` 区分探活并记录总预算与应答预算；`http_complete` 继续记录具体等待阶段。结合 `wda_restart` 与手机生命周期回调，可区分服务端主动重启和 XCTest 自行退出。

验证需包含：空闲及就绪状态切换无媒体请求、手动截图与手势、旧会话延迟请求不阻塞新会话、慢建连后的响应预算、普通请求占用连接时探活仍可进行、真实无应答仍有界、持续失败与恢复清零、SDK 冷却隔离及控制通道保留。合成测试不能代替部署后的真机稳定性验证。


## 中断证据与状态快照

schema 3 增加 PID 存活观测、已完成探活记录和停止原因。此次只增加证据，不改变 Ready 状态、控制授权、普通请求时限及探活重启政策，也不重放任何设备操作。

PID 监测使用单独的 DVT socket。iOS 17+ 通过当前 XCTest 已建立的 RSD 隧道开 socket，旧系统通过 lockdown 开独立连接。监测不借用 XCTest listener，不与生命周期 DVT socket 共用 writer，因此诊断写入超时不会留下半帧污染控制连接。连接和 deviceinfo channel 的建立合计最多 5 秒；每次 `isRunningPid:` 请求最多 5 秒。首次查询在 channel 建立后执行，之后每次从上次完成起延后 10 秒，最多一个查询在途，停顿后不补发积压轮次。

任一次连接、channel 建立或请求失败后，本 runner 的监测结束。超时可能留下迟到回复，因此直接丢弃整个诊断 socket，直到新 runner 才重新建立。`monitoring=false` 表示这个限制。监测 future 与授权和回调派发一起由 runner 持有；自然退出或取消时释放连接，没有独立轮询任务。最后一个样本可能早于 XCTest 退出，系统不为最终 PID 查询延长关闭或恢复流程。设备是否支持这条独立 DVT 连接仍需真机验证；`feature_disabled`、`setup_failed`、`channel_setup_failed` 均不能判定手机进程死亡。

| 事件 | 新增字段与解释 |
| --- | --- |
| `phone_process_launched` | native_pid、native_start_id、runner_id、phone_pid、event_seq；在启动返回 PID 后、授权之前记录 |
| `phone_process_observed` | process_state、process_category、process_age_ms、probe_duration_ms、monitoring；state 只为 running/not_running/unknown |
| `xctest_exited` | 固定 exit_category（test_plan_completed/runner_transport_disconnected/test_plan_timeout/socket_error/xctest_error）、stop_reason，以及最后 PID 样本的状态与年龄；不输出任意错误正文 |
| `xctest_exit_summary` | 生命周期时长、phone log/debug 条数和回调累计计数；scope=xctest_session |
| `wda_health_completed` | scope=wda_status、runner 身份、phone_pid、sequence、duration_ms、category、consecutive_failures、last_success_age_ms；只在真正完成 `/status` 请求后记录 |
| `wda_health_probe_skipped` | scope=supervisor_device_lock、runner 身份、operation_id、tool；只有操作名称和关联 ID，不含请求正文；没有可用操作身份时为 None |
| `wda_health_recovered` | 某 runner 的失败探活恢复成功；Ready 状态即使没变化也记录 |
| `xctest_stop_requested` | 首个 stop_reason 和 runner 身份，晚到的错误或 Drop 不覆盖它；停止时释放 monitor |
| `session_close_requested` / `ws_closed` | session、namespace、首个已知 reason；取消不能覆盖 browser_close、heartbeat_pong_missing、send_timeout、socket_send_failed、api_deleted 或 server_shutdown |

runner 的 stop_reason 取固定类别：startup_timeout、startup_cancellation、health_restart、device_offline、device_replacement、daemon_shutdown、usbmuxd_replacement、wda_reinstalled、unattributed。请求清理后出现 socket_error 时，仍保留最早的请求原因。unattributed 表示没有确定的归因，不能解释为手机崩溃。网关先记录停止原因，再取消会话和关闭 native；例如 browser_close → daemon_shutdown → socket_error 应解释为已请求清理后的传输退出。

原生 `daemon` 状态响应增加可选 `diagnostics` 字段。老快照缺少该字段时仍可反序列化；`state` 的含义保持不变。示意结构如下，时间、ID 和结果仅用于说明字段：

```json
{
  "diagnostics": {
    "runner": {
      "identity": {"native_pid": 34, "native_start_id": "e58e31a8-0cd9-40cc-a5cd-5a3beaa1f183", "runner_id": 1},
      "phone_pid": 1234,
      "last_process_observation": {"sampled_at_unix_ms": 1794432000000, "age_ms": 12000, "stale": false, "state": "running", "category": "deviceinfo_reply", "duration_ms": 15, "monitoring": true},
      "stop_reason": null,
      "exit_category": null,
      "event_sequence": 12
    },
    "last_probe": {"sequence": 3, "runner_id": 1, "sampled_at_unix_ms": 1794432010000, "age_ms": 2000, "stale": false, "duration_ms": 5001, "category": "response_timeout"},
    "last_success": {"sequence": 2, "runner_id": 1, "sampled_at_unix_ms": 1794432000000, "age_ms": 12000, "stale": false, "duration_ms": 12, "category": "ready"},
    "consecutive_failures": 1,
    "last_skip": {"sampled_at_unix_ms": 1794432011000, "age_ms": 1000, "active_operation": {"operation_id": 99, "tool": "tap"}},
    "stale": false
  }
}
```

`sampled_at_unix_ms` 是完成观测时的 UTC 时间，`age_ms` 用单调时钟在每次读状态时计算。状态读和 skip 写都不等待设备锁；锁被长操作占用时，旧样本仍不断变老。超过 30 秒标记 stale；没有完成探活时 diagnostics.stale=true，last_probe 为 null。skip 不生成假的探活，不重置失败或最后成功样本。runner 更换时清除旧探活元数据，保留的停止证据在新 runner 注册时替换。

`diagnostics.consecutive_failures` 统计这个 runner 的所有连续非 ready 已完成探活。重启确认只使用原有应答失败计数和 60 秒窗口；transport_unavailable 清空重启证据，状态快照中的诊断失败计数不能直接用作重启阈值。

真机验收按下列顺序保留证据：

- 新建一个受控会话，核对 namespace 下 schema 3 的 native_start_id、runner_id 和 phone_pid；确认正常闲置时 running 样本更新，界面不被采图。
- 执行一个占用设备锁的操作，确认 skip 携带 operation_id/tool，`last_probe` 时间不变、age 增长，操作后完成探活并继续更新。
- 关闭浏览器，核对 browser_close 是网关首因，daemon_shutdown 是 runner 请求停止原因。后续 socket_error 不得覆盖前述原因，也不得被标成手机崩溃。
- 用合成延迟或受控断链核对 unknown、monitoring=false 和 socket 释放；不要为验证 false 而杀掉正在使用的手机进程。
- runner 再次建立后，确认健康记录和最后 PID 观测对应新的 runner_id；容器重建后确认 native_start_id 已改变。
- 查询不被支持时，记录 setup/channel/request 固定分类并保留未知状态。合成测试通过只能证明分类、并发和取消行为；真机支持性、实际崩溃原因和长时间稳定性须单独验收。
