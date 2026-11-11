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

容量是文件大小限制，不保证固定小时数。TRACE 流量随预览和操作频率变化；测试结束应及时归档本次 namespace 的事件日志、诊断日志和网关日志。
