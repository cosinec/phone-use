# 首版实现与验证记录

日期：2026-11-09，Asia/Shanghai。分支：`codex/webusb-cloud-control`。代码基线：`4f1f59d`。

## 已交付的代码

浏览器使用发布版 `@limrun/device-install@0.1.0` 处理 USB 选择、配置重试、usbmux 字节通信和 WebSocket 转发。服务器通过每会话虚拟 `usbmuxd` 复用原有 `iphone-control` 的设备、签名、WDA 和恢复能力。首版接入保持原生源码不变，后续真机登录修复涉及两处小改动，见下文。

网页包含设备连接和准备、任务输入、步骤记录、确认与停止、截图和手动控制。AI 接口在服务器配置；未配置时明确显示状态。用户 Mac 在部署架构中只运行 Chrome，原生程序运行于服务器。当前 localhost 测试把本机作为云端角色，不代表外部云部署完成。

## 实际执行的检查

| 检查 | 结果及范围 |
|---|---|
| Node 自动化测试 | 96/96 通过，0 失败、跳过或取消。包含真实 HTTP/WebSocket/TCP/Unix Socket、原生 CLI fixture、发布 SDK 与明确标注的模拟 USB peer |
| TypeScript | `npm run typecheck` 通过 |
| 前端构建 | `npm run build` 通过 |
| 原生发布包 | `iphone-control0.1.4` 下载 SHA256 校验及 Mac 二进制签名验证通过 |
| 原生兼容性 | 未修改的发布版 daemon 经虚拟 mux 与模拟 Lockdown peer 通信，识别设备并返回 needs_trust；该项使用模拟设备 |
| 原生修复回归 | 14/14 通过，包含连接复用和管道密码输入的修复前失败、修复后通过验证 |
| 真实接入段 | 真实 iPhone18,3/iOS26.5.2，经 Chrome 发布 SDK → WebSocket → 虚拟 mux → 原生 daemon，实际读到型号和系统版本 |
| Chrome 页面 | 实际读取服务器配置，明确显示 AI 未配置；任务建议能填入文本框，未就绪时控制按钮保持禁用；桌面布局截图已检查 |
| 独立审查 | 网关、AI、网页分阶段审查，发现的问题已补 RED→GREEN 回归并修正；整分支最终复审单独记录 |

实际 USB 检查发现配置6的接口申请可能失败，配置3可用。生产代码直接复用 SDK 的候选配置遍历，不硬编码配置3。真实序列号尾部填充、迟到流数据、重复请求、进程组清理、取消后重连、Chrome fetch 接收者、停止按钮和 USB 拔线处理均有回归覆盖。

## 真机登录修复

真实手机已完成配对并确认开发者模式开启。Apple 登录进入双重认证后，原生请求报连接重置。使用相同 reqwest 版本的无账号网络诊断复现了复用 HTTP/1.1 连接时的重置，关闭空闲连接复用后连续请求均收到 HTTP 响应。

`vendor/plume_core/src/lib.rs` 设置 `pool_max_idle_per_host(0)`，让每次 Apple 请求使用新连接。`apps/iphone-control/src/main.rs` 在管道输入时跳过 `stty`。HTTP 回归使用本地明确模拟的服务器，密码输入回归在读取密码前结束 stdin，均验证修复前失败、修复后通过。相关原生测试 14 项通过，本机服务的原生二进制已替换为从当前源码编译的版本。

实际向导已完成 Apple 登录、设备注册、WDA 签名和安装。原生服务报告 WDA 就绪，签名包有效期为 7 天。接收包适配后，网页收到真实手机截图，从网页执行主屏幕按钮后，截图显示手机主屏幕。网页刷新画面也已实测成功，界面显示「可以控制」。在网页自动刷新运行期间，每 5 秒检查一次原生状态，8 次检查全部为 ready。

## USB 传输修复

原网关会把 65536 字节的 TCP 块直接转给 SDK，封装后 USB 包为 65572 字节，超过 usbmuxd 的 49152 字节发送上限。服务器现在按 49116 字节拆分 StreamData，保留发送顺序和写回调。1 MB 上传回归在修复前检测到超限包，修复后校验每包上限和完整字节顺序通过。[usbmuxd 上游 USB 上限](https://github.com/libimobiledevice/usbmuxd/blob/master/src/usb.h)

发布 SDK 会把一次 USB transferIn 当作完整 usbmux 包。新增真实发布 SDK 集成回归将版本回复拆成多次读取，修复前出现 DataView 越界。浏览器接收适配器按长度头组装完整包，处理拆包、合包、DataView 偏移和空传输，限制包长与缓冲区，保留 SDK 的设备配置、配对和协议处理。该集成回归与接收适配单测通过，网页测试合计 96 项通过。

Rust 网关迁移后，容器 Dockerfile 已改为从当前源码编译两个 Rust 可执行文件，复用上游 WDA 资源。容器构建仍待验证。本机验证使用当前源码构建的原生程序，idevice 编译时关闭调试断言，行为与 release 构建一致。

## 尚未完成的验证

- 真实手机坐标点按、滑动、长按、文字输入和完整自然语言任务。截图、网页主屏幕按钮已在后续真机验证中确认，尚未配置实际模型服务。
- 外部 HTTPS 云服务器、Docker 镜像运行和跨网络时延。本机没有 Docker CLI。
- 窄窗口实际视觉断点。浏览器 viewport API 未改变所观察 Chrome 页面的1642×943尺寸，因此未将该项记为通过；布局代码与相关组件测试保留。

原始手机标识、配对凭据、账号、密码和模型密钥不进入此记录或源码包。运行目录、环境文件和截图数据均在 Git 忽略规则内。后续真实操作应在网页向导完成授权后继续验收。

## Rust 网关迁移

服务端入口迁移到 `crates/ictl-gateway`，启动命令和 Docker 运行阶段切换到 Rust。原 Node 实现移至 `tests/reference`，作为迁移前协议的测试参照。保留 React/TypeScript 工作台、发布版 WebUSB SDK 和原 Rust 控制引擎。

自动化测试使用独立 Rust 服务进程、Node 原生 CLI fixture、HTTP 模型 fixture 和发布版 SDK，覆盖配对恢复互斥、命令去重及缓存淘汰、USB MTU、准备输入、任务确认与停止、静态文件、配置传递和 HTTP 读取期限。

本机缺少 Docker，Linux 容器镜像与公网 VPS 链路尚待独立验证。

本次已在 `http://127.0.0.1:8787/` 用 Rust 网关替换原 Node 服务，Mac Chrome 重新选择真实 iPhone 后恢复原配对记录和签名目录。页面显示“可以控制”并返回真实截图，点击主屏幕后操作和截图流程结束，控件恢复可用且页面无操作错误。模型仍未配置。该证据覆盖本机 Rust 网关和真实 USB 链路，未覆盖公网时延、Linux 容器和真实模型任务。

迁移完成检查通过。Rust 网关 `cargo test -p ictl-gateway --locked` 为 12/12，通过指定实际网关二进制执行 `npm test` 为 104/104，包含 8 项 Rust 服务跨语言集成测试，0 失败、0 跳过。TypeScript、Vite 构建、Rust fmt 和 Clippy `-D warnings` 通过。独立审查已复核配置继承和 HTTP 读取期限两处修正。


## VPS 部署验证

2026-11-09 在 Linux x86_64 VPS 实际完成 Docker 构建与启动，公网入口为 `https://amazingly.top/iphone/`。复用现有域名、证书和 Nginx，通过标准 HTTPS 443 提供网页、REST 和 WSS。初选 9443 在公网访问超时，已撤销临时端口配置。实际修改的 Nginx 配置已备份，原网站主页与既有服务路径另行检查。

依赖锁文件的内网 npm 地址改为公共 registry，版本和完整性校验值保持原样。Dockerfile 默认单任务编译两个 Rust 程序，支持 `WEB_BASE` 构建参数，许可证生成使用经官方 SHA256 校验的 cargo-about 0.9.3 发布包。编译期间增加的临时交换文件已关闭并移除。

运行镜像为 `iphone-control-webusb:vps-20261109`，镜像清单摘要为 `sha256:7bd0eb644fa147ab82980a4b7d7463f19efdd1b1afb6d024a3d5430789cae7eb`。Rust 网关绑定服务器回环地址 8787，运行目录采用独立持久化挂载，容器配置自动重启、内存与进程限制及日志轮转。访问令牌、Magpie 专用调用密钥均保留在服务器受限环境文件中。

公网独立检查已确认以下结果。

- `/iphone/`、JS、CSS 与 `/api/config` 返回 200，TLS 证书校验通过。
- 缺少控制令牌的创建会话请求返回 401，非法 origin 返回 403。
- 合法控制令牌可创建明确标注的合成设备会话，返回正确的公网 WSS 地址。
- WebSocket 错误令牌返回 401，非法 origin 返回 403，合法握手返回 101，检查后关闭合成会话。
- Chrome 实际打开部署入口，显示工作台与已配置的 `codex/gpt-6.1-sol`。
- 本地重新执行 104 项浏览器/协议测试与 12 项 Rust 测试，全部通过。TypeScript 和 `/iphone/` 前缀的 Vite 构建通过。

AI 沿用当前 Rust TaskManager 的观察与操作循环，通过 VPS 现有 Magpie 模型 API 发起视觉 Chat Completions。独立模型探测使用红蓝测试图片，HTTP 200，耗时 3.82 秒，返回正确的 JSON 完成消息。该项验证的是模型 API，未将其计为真实手机任务验收。

用户选择先完成部署、暂不连接手机，本次未进行 VPS → 浏览器 → 真实 iPhone 的操作验收。原有 Mac localhost 真机证据仍见上文。Apple 登录资料、私钥和本地签名目录未迁移到 VPS，首次云端连接需要按网页向导完成配对及 WDA 准备。后续需验证真实手机截图、手动操作、自然语言任务、重连与公网时延。
