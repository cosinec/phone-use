# Browser-owned iPhone cloud control

Approved direction: the user selected Mac Chrome + WebUSB + WebSocket + cloud AI/device control, requested a new branch and implementation, and explicitly asked to maximize reuse. Earlier implementation pause was superseded by this request. Branch: `codex/webusb-cloud-control`, upstream baseline `4f1f59d6ef37d676e4ee9aeb5fb23b482c5b22c1`.

## Product behavior

A user plugs an iPhone into their own Mac, opens a Chrome website, grants USB access, completes iPhone trust/developer authorization, and describes a task. The browser forwards USB/device streams to a server. The server runs the existing iphone-control daemon and optionally an AI loop. The website shows screenshots, steps, errors and confirmation requests. No native helper is required on the user's Mac in the deployed architecture. Chrome must keep the page open while the device channel is in use.

The server may run on Linux or macOS; the user's first supported client is macOS Chrome. It serves the web application and WebSocket gateway from the same HTTPS origin in production. HTTP localhost is supported only for development. A separately published frontend is not sufficient to replace the native server process.

## Reuse boundaries

* Keep all existing Rust source unchanged. Reuse its CLI `daemon` and `setup`, JSON control socket, WDA HTTP/XCTest handling, signing, DDI, HID fallback and recovery.
* Use published `@limrun/device-install` version `0.1.0` for USB selection, usbmux session, browser pairing record and binary WebSocket relay. Implement its documented/source-confirmed `/ios/device/ws` and version-1 16-byte frame protocol on our server; no Limrun subscription is needed for our own relay implementation.
* Reuse the interaction behavior of PR #34: screenshot point coordinates, pointer tap/drag/long-press, hardware buttons and text input. Attribute its BSD/MIT upstream source rather than copying unrelated stacked English changes.
* Optional Web Inspector/PR #36 and Windows are outside this first implementation.

## Cloud transport

Each authenticated browser session owns one virtual usbmuxd TCP listener on loopback, one pair-record store in memory, an independent native daemon/control socket, and one bounded WebSocket. Native signing data is isolated between devices and owners, but can be reused by a later non-concurrent session that supplies its stored browser pair record. Index the server-generated data namespace by SHA256(accessToken + pairRecordBase64), persist the index with owner-only permissions, and enforce one active holder. Closing a channel terminates processes and clears sockets, while retaining signing state so reopening the website does not require a new Apple login/signature. The virtual listener implements `ListDevices`, `Listen`, `ReadBUID`, `ReadPairRecord`, `SavePairRecord`, and `Connect` using XML plist packets with little-endian headers. `Connect.PortNumber` is network-order encoded; decode it before sending a relay `OpenStream`. After `OpenResult` succeeds, return usbmuxd `Result(0)` and forward raw TCP bytes as relay StreamData. Distinguish socket fragmentation/coalescing from message boundaries.

The native child receives `USBMUXD_SOCKET_ADDRESS=127.0.0.1:<session port>`, `ICTL_MANAGE_USBMUXD=0`, `IPHONE_UDID=<session UDID>`, `ICTL_DATA_DIR=<session directory>`, `ICTL_SOCKET=<short session control path>`. WDA installation is still performed by the unmodified native setup. Its interactive prompts are surfaced through a per-session setup transcript and one-time input API. Passwords/2FA input are never stored in transcripts or request logs. A SavePairRecord response also produces SDK PairRecordReady. An existing browser pair record can be supplied when opening a new session. Pair records and native account material are sensitive; runtime data is owner-only, excluded from Git, and the website clearly says signing runs on the configured server.

## Interfaces

`createGateway(options)` returns `{server, listen(host,port), close()}`. Options include a nonempty `accessToken`, exact `allowedOrigins`, `runtimeDir`, and `controllerFactory(session)` for production/native or integration-test fixture. UI routes live under `/api` and use `Authorization: Bearer <controller token>` for session creation; subsequent session endpoints use the returned random session token.

* `POST /api/sessions` body `{device: {serialNumber,productId,vendorId,productName?}, pairRecord?}` returns `{id,token,relayUrl,state}`; Apple VID and UDID are validated.
* `GET /api/config` returns readiness/model name, never credentials.
* `GET /api/sessions/:id` returns current daemon readiness, setup state and task state.
* `POST /api/sessions/:id/setup` starts native setup; `/setup/input` accepts `{line}`; GET state includes bounded transcript and setup exit status.
* `POST /api/sessions/:id/command` accepts `{requestId,deviceId,tool,args}` with allowlisted iphone_* tools; `GET .../screen` returns `{imageBase64,caption,elements,deviceId}`.
* `POST /api/sessions/:id/tasks` accepts `{instruction}`; GET session state returns task steps and pending confirmation. `/tasks/:taskId/stop` stops future operations; `/tasks/:taskId/confirm` takes `{actionId,approved}`. DELETE session closes it.
* `/ios/device/ws?token=<session token>` implements the SDK relay protocol. Origin and session identity are checked before native startup. A second WebSocket cannot replace an active one.

Commands map to existing serde Request `op` values. Validate finite point coordinates, gesture durations (0..10 sec), indices, text length, URL scheme and button enum before dispatch. Use `expect_udid` and `cancel_on_close`. Side-effecting commands are not retried on timeout/interrupted response. Serialize device actions; request IDs are deduplicated within a bounded session cache. Disconnect invalidates the session, aborts AI/setup and terminates owned processes/streams without killing system usbmuxd.

## AI behavior

Cloud model settings come from `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`; compatible Chat Completions text+vision can return a validated JSON action or completion. No API credential is shipped in browser/source. Bound instructions, history, image size, model timeout, task steps and runtime. Treat phone text as untrusted observation. The model must mark potentially destructive/external actions for confirmation; additionally require confirmation for submit, terminate and non-http URL commands. A stop invalidates the task generation so no later model reply can launch a command. An already sent phone action cannot be undone and is reported honestly. Without configured AI, manual commands still work and task start returns an explicit configuration error, never canned AI output.

## Verification and delivery

Use Node behavioral tests with real HTTP/WebSocket/TCP sockets and a transparent fake USB peer/native CLI fixture. Prove fragmented plist framing, byte-exact bidirectional streams, network-order port mapping, pair-record responses, per-session isolation, authentication/origin rejection, disconnect cleanup, command validation and stop/late-response behavior. Test browser wrappers by injecting a SDK-shaped USB transport, while importing the real SDK in production. Build the React/Vite client and inspect it in Chrome via CUA. Provide reverse-proxy/Docker instructions and a source archive. Run a native binary protocol smoke check where available. No real device pass is claimed unless a physical iPhone is attached and the full chain is observed.

The current host reports no attached iPhone. Physical WebUSB exclusive-interface access, WDA startup through the new virtual gateway, and Apple signing require subsequent real-device evidence. These are verification limits, not simulated successes.
