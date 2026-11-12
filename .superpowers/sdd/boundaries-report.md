# Control boundary implementation and verification

Worktree: `/Users/bytedance/.codex/worktrees/wda-lifecycle-diagnostics/phone-use`.
Branch: `codex/wda-lifecycle-diagnostics`.
Starting HEAD: `278b9b5` (reviewed WDA diagnostics and truthful cleanup attribution).
Status: source implementation and local verification complete; parent full gateway run and independent review pending. No push, deployment, VPS write, or real-device action.

## Behavior

- Gateway spawn forces `ICTL_CAPTURE_POLICY=bounded-remote`, independently of `ICTL_LOW_LATENCY`. Every daemon-owned WdaClient carries bounded capture, including hidden unlock/settle reads. MJPEG errors remain available; unsupported capture and both explicit/implicit CoreDevice PNG fallbacks are rejected before tunnel access. Local native capture/fallback remains available. The existing 8-second/2-MiB transport limit and image version 0.25.10 are unchanged.
- `Request::requires_control` is the shared classification for commands that change the device or can automatically unlock it. Status, list-apps and list-devices stay safe. Screenshot/observe/list-elements/wait-for use control admission and expiry protection.
- HTTP dispatch stamps entry before body collection, registry/queue/readiness waits; internal task commands stamp their own entry. The original same-host CLOCK_MONOTONIC nanosecond deadline stays with the Job, crosses native IPC unchanged, and is checked at gateway dequeue/after readiness, before IPC connect/write, and after the daemon device lock. The separate resign lock path checks too. Local 30-second protection is retained for absent metadata; malformed/null/noninteger/excessively future metadata and clock/overflow errors fail closed. Duplicate IDs subscribe to the original job/result and cannot renew expiry or replay an action.
- A session arbiter atomically admits manual jobs and exclusive typed task leases. Manual permits remain with queued/inflight jobs; the task runner/manager and task jobs retain the same ownership generation through observation, model calls, recovery and confirmation. Stop cancels authority, while queued/inflight task jobs retain ownership until they settle/drop. Public taskId/deadline JSON cannot supply authority. Cached preview and safe status remain available. Already-sent actions keep the existing uncertainty and cancellation behavior; expiry does not change execution timeout or retry them.
- HTTP setup/setup-input and the no-pair-record WebSocket StartPairing setup path use manual admission. Native setup retains its permit through child lifetime/input waiting, blocking task claim. Pair-record reads stay allowed. Busy WS setup returns a fixed bounded Error frame, keeps the WebSocket/task alive, and records rejection. Later setup failure returns a fixed Error frame; if its bounded relay queue cannot accept the response, a fixed drop event is recorded.

## Files

- `crates/ictl-protocol/src/lib.rs`: canonical control classification; deadline constant/type/checked monotonic clock; metadata unit tests.
- `crates/ictl-daemon/src/config.rs`, `supervise.rs`, `tools.rs`, `core.rs`, `lib.rs`: policy selection and propagation, lazy fallback/shared HID guard, strict parsing, device-lock/resign expiry and regressions.
- `crates/ictl-wda/src/client.rs`: bounded capture flag independent of timing, unsupported/error rejection and transport regressions.
- `crates/ictl-gateway/src/control.rs`, `lib.rs`, `gateway.rs`, `controller.rs`, `native.rs`, `tasks.rs`: atomic admission/leases, unchanged deadline propagation, ingress stamp, typed task paths, setup lifetime and HTTP/WS rejection.
- `browser-control/tests/fixtures/native-cli.mjs`, `browser-control/tests/rust-gateway.test.mjs`: counters/env evidence and real gateway HTTP/WS contracts.
- `docs/dev/wda-diagnostic-logging.md`, `docs/superpowers/specs/2026-11-12-control-boundaries-design.md`, `.superpowers/sdd/boundaries-brief.md`, this report: rejection categories, operating limits, compatibility and evidence.

No dependency manifest/lockfile, vendor source/provenance, SDK bundle, global configuration or video-stack changes. The only browser fixture helper change exposes its existing peer for the focused WS regression.

## RED evidence

Tests were added with old-behavior/no-op scaffolds where a new typed interface was required, run to behavioral assertion failure, then implemented. Compilation or fixture-envelope errors were corrected before being counted as RED. The initial Android response fixture lacked its device/result envelope and was corrected. A GREEN daemon assertion was updated to recognize the Chinese expiry response; expiry logic was already rejecting correctly.

All Cargo commands below use:

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' <subcommand/options> --offline
```

| Command / RED log | Observed expected defect |
| --- | --- |
| `test --locked -p ictl-daemon -p ictl-wda --lib bounded`; `/tmp/wda-boundaries-red-capture.log` | Daemon remote fallback provider called 1 time, expected 0; shared HID orientation entry returned phone-not-connected instead of policy denial. Cargo stopped after daemon failures. |
| `test --locked -p ictl-wda --lib bounded_capture`; `/tmp/wda-boundaries-red-wda.log` | 0/2 pass: latency-disabled bounded client used zero MJPEG captures; unsupported transport attempted PNG instead of fixed unsupported error. |
| `test --locked -p ictl-protocol --lib`; `/tmp/wda-boundaries-red-protocol.log` | 5/7 pass: null deadline accepted; screenshot not classified as control despite automatic unlock. |
| `test --locked -p ictl-protocol -p ictl-daemon --lib deadline`; `/tmp/wda-boundaries-red-deadline.log` | 0/2 daemon regressions pass: malformed null accepted; elapsed upstream deadline reached HID path despite fresh local arrival. |
| `test --locked -p ictl-gateway --lib expired`; `/tmp/wda-boundaries-red-gateway-deadline.log` | 0/2 pass: 31s-old gateway admission dispatched; expired native request reached IPC socket. |
| `test --locked -p ictl-gateway --lib control::tests`; `/tmp/wda-boundaries-red-control.log` | 0/3 pass: queued manual did not prevent task claim; foreign lease accepted; cancelled task job still authorized. |
| Node `--test-name-pattern='control boundaries'`; `/tmp/wda-boundaries-red-ownership.log` | 0/5 pass: forced capture policy missing, manual tap returned 200 during model/confirmation waits, and new task returned 201 while manual observation pending. |
| Node `--test-name-pattern='anchor action age'`; `/tmp/wda-boundaries-red-http-entry.log` | Slow HTTP body wait omitted: queueMs=0, expected at least 100ms. |
| Node `--test-name-pattern='hold task ownership'`; `/tmp/wda-boundaries-red-setup.log` | setup returned 200/running during model and confirmation ownership, expected 409. |
| `test --locked -p ictl-gateway --lib setup_accepts`; `/tmp/wda-boundaries-red-setup-lease.log` | Setup child waiting for input released manual admission, allowing task claim. |
| Node `--test-name-pattern='websocket pairing setup'`; `/tmp/wda-boundaries-red-ws-setup.log` | StartPairing changed setup from idle to running while task owned session. |
| `test --locked -p ictl-daemon --lib expired_resign`; `/tmp/wda-boundaries-red-resign.log` | Separate resign branch bypassed expiry, returning ordinary device-unavailable error. |

Node commands use the actual current gateway binary and the existing native/USB/model fixtures:

```bash
RUST_GATEWAY_BIN="$PWD/target/debug/iphone-control-gateway" node --test --test-name-pattern='<pattern>' browser-control/tests/rust-gateway.test.mjs
```

## GREEN and final local verification

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --locked -p ictl-protocol -p ictl-wda -p ictl-daemon -p ictl-gateway --lib --offline
```

**201 passed, zero failed:** daemon 57, gateway 46, protocol 7, WDA 91. Log `/tmp/wda-boundaries-final-rust.log`. This reruns the existing diagnostic/restart regressions as well as boundary tests. The earlier Task1 baseline was daemon 50/gateway 39/WDA 89; it was supplied by the parent, and the final run includes those source tests.

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --locked -p iphone-control --bin iphone-control phone_logs --offline
```

1 passed, 2 unrelated binary tests filtered. Log `/tmp/wda-boundaries-final-app.log`.

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' clippy --config 'source.crates-io.replace-with="rsproxy-sparse"' --locked -p ictl-protocol -p ictl-wda -p ictl-daemon -p ictl-gateway -p iphone-control --all-targets --offline -- -D warnings -A clippy::nonminimal_bool
cargo +1.90.0 fmt --package ictl-protocol --package ictl-wda --package ictl-daemon --package ictl-gateway --package iphone-control --check
git diff --check
```

Passed. Clippy log `/tmp/wda-boundaries-final-clippy.log`. The one allow is for unchanged `ictl-unlock` baseline nonminimal_bool; source routing must be repeated after the external clippy subcommand. Existing environment warnings remain: both user Cargo config filenames exist and apple-codesign emits its prior 10 dependency warnings. No boundary-source warnings remain.

The current gateway binary was rebuilt successfully after all WS/source changes: `/tmp/wda-boundaries-build-stable-gateway.log`.

Focused HTTP/WS verification: 8/8 boundary contracts passed in `/tmp/wda-boundaries-green-final-contract.log`, including forced capture policy, model/confirmation waits, typed task actions, release/dedupe, queued manual observation race, setup lifetime, recovery/stop and HTTP body age. After the final WS StartPairing source change, its new regression passed 1/1 in `/tmp/wda-boundaries-green-ws-setup.log`: setup stayed idle, fixed Error arrived, WebSocket stayed open and the owning task completed. No duplicate full gateway suite was launched by this worker. The parent's first full current run finished 77/79: the only failures were two legacy deepEqual counter objects missing the fixture's new zero-valued launch_app/terminate_app/press_button fields. Both expected objects were updated explicitly, preserving strict assertions; the two focused regressions pass in `/tmp/wda-boundaries-legacy-counters-recheck.log`. The parent is running the final full suite after that fixture-only correction.

Supplementary Rust tests cover 19s before IPC + 12s native queue (both individual waits under 30s, total expired), local-only old-client guard, post-readiness recheck using a 40ms monotonic deadline and virtual 30s readiness timer, 16 atomic manual/task admission races, cancellation/foreign lease/closed session behavior, and exact original deadline on fresh IPC. No real 30-second expiry sleep or wall-clock adjustment was used.

## Privacy and limits

New logs contain fixed categories/stages, session/namespace or existing diagnostic IDs, queue age and budget. They do not log command args, task instructions, setup inputs, model content, image bytes, pairing records or request bodies. Core rejection uses the existing device-request correlation span; regular IPC rejection uses RequestTrace. Setup has no RequestTrace and uses its setup stage/start namespace evidence. The parser rejects invalid metadata without formatting its raw value. Storage/caching remains bounded by existing queue/ID limits and the arbiter stores only counters, one ownership generation and cancellation state.

Tests prove admission/expiry/no-fallback and permit lifetime using real source plus local synthetic providers. They do not prove physical CoreDevice/WDA behavior on this phone, actual live daemon action completion after an uncertain sent request, phone-specific DVT support, long-term stability, or the cause of historical CPU/socket events. Clock-error/overflow branches fail closed in code and arithmetic is tested; no real clock syscall failure was injected. No vendor tests were repeated because vendor source was unchanged; the reviewed diagnostics vendor baseline remains in task-1-report.

Gateway/native must be upgraded together. The internal deadline assumes both processes share the host/container CLOCK_MONOTONIC; it is not a cross-host field. Existing packaged images bundle both. Old daemons ignoring the new metadata cannot provide total post-IPC expiry. No broader mixed-version negotiation is added.

Upstream PR 42 remains scope context only: no video-stack merge; last observed phone iOS 26.5.2; cpu_resource_fatal cause unproven. No production or device acceptance claim.

## Parent integration and review

First parent full run: 77/79, only the two fixture-schema assertions described above; log `/tmp/wda-boundaries-full-contract.log`. Their focused rerun: 2/2. Pending final parent full gateway contract results, independent full-path review and local implementation commit ID. The old Task1 full-run cold-readiness timeout and subsequent named rerun remain transparently recorded in task-1-report; they are not substituted for a clean boundary full-suite run.
