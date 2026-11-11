# WDA 传输稳定性修复（2026-11-11）

本分支从 `main` 的 `4391875` 开始，只修复代码审查确认的问题，不修改健康检查的重启阈值，不部署服务。

## 修复范围

- 网关心跳按 Ping 实际发送完成时间安排下一次检查，定时器优先于待发数据。调度延迟不会补跑两次心跳，也不会因为持续发送而永远不发 Ping。发送限时仍为 20 秒；Ping 后等待 Pong 的周期仍为 30 秒。
- WDA HTTP 请求记录 `pool / probe / connect / write / flush / read` 阶段、耗时和是否复用连接。外层请求期限和内层 10 秒建连期限都记录诊断。请求开始写入之前超时归为不可达；开始写入以后仍归为结果未知，不重放 POST，也不允许退到 HID 重做。日志不包含 query 或请求正文。
- jktcp 的共享驱动在底层写入 Pending 时继续读包和处理关闭。保留部分 IP 包写入偏移，输出队列有界，传输错误传递给调用方。直接使用 AdapterStream 的接口 保持原有语义。

`main` 原本直接使用 jktcp 0.1.8。本次将已审查的 `5bea928` 中 `vendor/jktcp` 引入作为修复基线，保留其发送取消、ACK 重传计时和连接清理修复，再补充双向背压修复；没有合并该部署分支的浏览器、签名、daemon 等改动。来源和许可证见 `THIRD_PARTY.md`。

## 验证

心跳测试先在旧实现上复现两个失败：连续流量饿死心跳，以及调度延迟后立即误断；缺失 Pong 的原有行为测试通过。WDA 测试先复现建连、等待连接池、部分发送、等待响应的超时误分类或阶段信息缺失，另复现内层建连超时诊断缺失。

TCP 测试使用有界全双工内存传输，人为阻塞发送方向，同时注入接收数据。测试条件不代表 VPS 当时实际缓冲区大小或拥塞情况。对应旧代码接收超时，对照排空发送方向后正常。

常规验证命令（Rust >= 1.88；本次使用 1.90.0）：

```sh
cargo test --locked -p ictl-wda -p ictl-gateway -p ictl-device -p ictl-daemon --lib
cargo test --locked --manifest-path vendor/jktcp/Cargo.toml --lib -- --skip tests::local_tcp --skip tests::handle_speed
cargo clippy --locked -p ictl-wda -p ictl-gateway --all-targets -- -D warnings
cargo clippy --locked --manifest-path vendor/jktcp/Cargo.toml --all-targets -- -D warnings
cargo fmt -p ictl-wda -p ictl-gateway -- --check
cargo fmt --manifest-path vendor/jktcp/Cargo.toml -- --check
```

本次最终结果：受影响四个模块共 165 项库测试通过，独立 jktcp 库 31 项测试通过；修改的应用包与 jktcp 严格 Clippy 通过，jktcp 的 `wasm32-unknown-unknown --no-default-features` 检查通过。独立 vendor 测试锁定 Tokio 1.50.0；应用模块使用工作区锁定的 Tokio 1.54.1。

两个上游 TUN 手工测试需要系统网络接口和权限，不纳入合成回归。真机长时间运行尚需部署后验证：预览开启/关闭、操作与截图、网络短暂抖动、重连、关闭页面，关联 WDA 健康日志、网关关闭原因和 XCTest 退出原因。

## 归因边界

历史日志证明健康检查连续失败触发了 WDA 重启，但未证明 USB 物理连接频繁断开。`/status` 直接走 usbmux，XCTest 才走软件 TCP；合成回归通过不等于已经确认或消除了当时所有重启原因。

扩大到 daemon 的严格 Clippy 检查会遇到未改动的 `ictl-unlock/src/lib.rs:120` 上 `nonminimal_bool` 告警；全仓格式检查包含既有第三方 vendor 的格式差异。上述命令分别检查本次修改的包和 jktcp，不把它们描述为全仓静态检查通过。
