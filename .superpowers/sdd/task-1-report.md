# Task 1 implementation and verification report

Task: correlated WDA interruption evidence. Local implementation is verified and ready for independent parent review; no push, deployment, VPS write, or real-device reproduction was performed. The later control-boundary task and its two untracked design/plan documents are excluded.

Worktree: `/Users/bytedance/.codex/worktrees/wda-lifecycle-diagnostics/phone-use`.
Branch: `codex/wda-lifecycle-diagnostics`.
Feature baseline: `53fdfb2069c046a9d1c2dd8e8bac49425d0def13`.
Task starting HEAD: `17d3bbe` (approved design and plan).
Implementation commit: `896b183` (`feat: correlate WDA process health and shutdown evidence`).
Report commit: separate local documentation commit after implementation verification.

## Implemented behavior

- idevice has an optional synchronous typed ProcessObserver. Launch PID is emitted before authorization, including later authorization failure. Unrelated callers default to no observer. The app no longer parses formatted DEBUG PID logs or opens the idevice DEBUG filter for this purpose.
- PID monitoring owns an independent DVT socket. On iOS 17+ it opens that socket over the already-established RSD tunnel and retained handshake; older paths open a separate lockdown connection. It never borrows the lifecycle listener or lifecycle DVT writer. The monitor future is raced with authorization/driver setup/callback dispatch and dropped with the owning run.
- Connection plus channel setup share a 5-second budget; each request is bounded to 5 seconds. Probes run once initially, then delay 10 seconds from completion, with one in flight and no catch-up bursts. Any setup/request error or timeout records unknown and retires the entire diagnostic socket, preventing late replies, queue accumulation and cancelled partial DTX writes from affecting the lifecycle transport. Monitoring resumes only with a new runner.
- `is_running_pid` accepts only Boolean replies. True is running, false is not-running, and malformed/failed/timeout/unsupported observations are unknown. No process list, executable path or phone payload is collected.
- Every runner has native_pid, native_start_id UUID, runner_id and optional phone_pid. Container PID and runner counter reuse do not merge process generations. Existing gateway session/namespace/PID logs bridge to namespace-specific native logs and the schema-3 native startup marker.
- Native status gains optional diagnostics. Health records include only actually completed probes, sequence, runner ID, completion timestamp, duration, category, consecutive diagnostic failures, last success and ages. Independent metadata is updated/read without the long-held device lock; ages are derived from monotonic time on each status read. Missing completed probes and samples older than 30 seconds are marked stale. Startup runner metadata is registered before launch; replacement resets health records. Busy ticks record operation ID/tool only and leave prior samples intact. Recovery is emitted even if Ready never changed.
- Runner stop reasons are explicit at health restart, device offline/replacement, usbmuxd replacement, reinstall, daemon shutdown, startup timeout and cancellation. The first stop reason stays sticky through later Drop/socket errors. XCTest exit categories name the session error scope and preserve the last PID observation and age; they never assert a phone crash from a socket error.
- Gateway close reasons are shared with its writer. Browser close, heartbeat failure, send timeout/failure, API deletion, native startup failure, pair-save failure and server shutdown record a first known cause before cancellation. Later cancellation cannot replace it.
- The diagnostic guide documents schema 3, stale/unknown interpretation, the independent-connection limitation and a real-device acceptance checklist. THIRD_PARTY and provenance retain upstream hashes and add current hashes for all cumulative vendored modifications, including the new diagnostics source.

The 3-failures/60-second response-confirmation restart policy, Ready labels, normal control budgets and no-replay rules are unchanged. Diagnostic consecutive failures count all completed non-ready health results; this count is not the policy's response-failure confirmation count.

## TDD RED evidence

Tests were written with minimal old-behavior/no-op scaffolds, executed to behavioral assertion failures, then implemented. Tool-routing/compilation errors were corrected before they were counted as RED.

| RED log | Expected failure |
| --- | --- |
| `/tmp/wda-diagnostics-red-process.log` | 0/4 pass: malformed `"false"` treated as process exit; typed launch observer received nothing; true response incorrectly classified not-running; pending monitor blocked lifecycle until the test deadline |
| `/tmp/wda-diagnostics-red-health.log` | 0/3 pass: last_probe/last_success absent, no stale default/reset behavior, busy skip absent |
| `/tmp/wda-diagnostics-red-stop.log` | Requested daemon_shutdown was overwritten by unattributed after socket error: left Some(Unattributed), right Some(DaemonShutdown) |
| `/tmp/wda-diagnostics-red-gateway.log` | Browser-close first cause was overwritten: left socket_send_failed, right browser_close |
| `/tmp/wda-diagnostics-red-app.log` | Old DEBUG bridge plus typed launch emitted duplicate launch evidence: count 2, expected 1 |
| `/tmp/wda-diagnostics-red-setup.log` | 7/8 pass; shared setup bound failed with connection+channel taking 8.00282425s, expected under 5.5s |

The initial process RED included:

```text
strict_pid_boolean_reply: malformed replies are unknown, never process exit
launch_pid_is_typed_before_later_failure: expected [ProcessEvent::Launched { pid: 1234 }]
process_errors_are_unknown: left NotRunning, right Running
pending_monitor_does_not_block_lifecycle_and_is_dropped: Err(Elapsed(()))
test result: FAILED. 0 passed; 4 failed
```

Additional synthetic DVT tests use real RemoteServerClient/DeviceInfoClient channels over duplex sockets: true/false/malformed replies, a pending request while the actual XCTest callback dispatcher runs, owner cancellation followed by socket EOF, timed-out requests followed by socket EOF, and the shared connection/channel budget. The metadata integration test holds the daemon device lock and verifies tick skips and status return promptly with the active operation identity.

## Verification commands and results

All Cargo calls use Rust 1.90, invocation-local source routing and the same worktree target cache. The supplied baseline log was read and verified: 46 daemon + 38 gateway + 86 WDA = 170 passing tests (`/tmp/wda-diagnostics-baseline.log`).

Final affected crate verification:

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --locked -p ictl-wda -p ictl-daemon -p ictl-gateway --lib --offline
```

Result: 50 daemon + 39 gateway + 88 WDA = 177 passed, zero failed. Log: `/tmp/wda-diagnostics-final-rust.log`.

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --locked -p iphone-control --bin iphone-control phone_logs --offline
```

Result: 1 passing logging test, 2 unrelated binary tests filtered. Log: `/tmp/wda-diagnostics-final-app.log`.

```bash
CARGO_TARGET_DIR="$PWD/target" cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --manifest-path /tmp/wda-vendor-diagnostics/Cargo.toml --locked --no-default-features --features ring,xctest,device_info --lib services::dvt --offline
```

Result: 12 focused vendor tests passed: 8 diagnostic/channel regressions plus 4 pre-existing launch NSError tests; 8 unrelated tests filtered. Log: `/tmp/wda-diagnostics-final-vendor.log`.

```bash
CARGO_TARGET_DIR="$PWD/target" cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --manifest-path /tmp/wda-vendor-diagnostics/Cargo.toml --no-default-features --features ring,xctest --lib diagnostics --offline
```

Result: 4 passed, including feature_disabled unknown and proof that the diagnostic connection future is never polled. Log: `/tmp/wda-diagnostics-feature-disabled.log`.

Vendor fixture details: Cargo rejects testing idevice through `-p idevice` because it is excluded from the workspace and needs dev-dependencies; `--features` on an excluded package is also rejected. Standalone vendor Cargo resolution in offline mode lacked unused optional dependency index entries. The `/tmp/wda-vendor-diagnostics/Cargo.toml` fixture uses the real repository `vendor/idevice/src/lib.rs` through `[lib].path`, the real patched jktcp through `[patch.crates-io]`, and a copy of the workspace lockfile. It omits only unavailable unused optional dependencies (chacha20poly1305, ed25519-dalek, idevice-srp, obfstr, rustls-rustcrypto, siphasher, tokio-openssl, x25519-dalek), their `dep:` references, and unused tun-rs dev-dependency. No repository vendor dependency manifest or global Cargo configuration is changed for this workaround. The tests compile the actual source with the native xctest/device_info feature flags, not a reimplementation.

Formatting and diff integrity:

```bash
cargo +1.90.0 fmt --package ictl-wda --package ictl-daemon --package ictl-gateway --package iphone-control --check
rustfmt +1.90.0 --edition 2024 --config-path /tmp/wda-vendor-rustfmt.toml --check vendor/idevice/src/services/dvt/device_info.rs vendor/idevice/src/services/dvt/xctest/mod.rs vendor/idevice/src/services/dvt/xctest/diagnostics.rs
git diff --check
```

Passed. Vendor formatter configuration is `max_width=100`, `use_small_heuristics="Default"`, preserving upstream style; the root uses 120/Max. An initial vendor formatting run picked root style and expanded unrelated diffs; it was corrected before commit. Stable rustfmt ignores unstable skip_children, so that setting was removed from the final local config.

Affected-target Clippy:

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' clippy --config 'source.crates-io.replace-with="rsproxy-sparse"' --locked -p ictl-wda -p ictl-daemon -p ictl-gateway -p iphone-control --all-targets --offline -- -D warnings -A clippy::nonminimal_bool
```

Passed. Log: `/tmp/wda-diagnostics-clippy-affected.log`. The config override is repeated after the external clippy subcommand because the leading Cargo config alone was not inherited by clippy's Cargo subprocess, which otherwise attempted the obsolete global rsproxy source.

Strict `-D warnings` without the one allow fails on the unchanged dependency `ictl-unlock/src/lib.rs:120` (`nonminimal_bool`); `git diff 53fdfb2 -- crates/ictl-unlock/src/lib.rs` is empty. This existing code was left unchanged. The diagnostic implementation's own collapsible_if lint was fixed before the passing run.

Existing warnings: Cargo reports both `/Users/bytedance/.cargo/config` and `config.toml` and chooses config; apple-codesign emits 10 existing dependency warnings. These appear in the supplied baseline and final affected builds. No diagnostics-source warnings remain. The temporary unused app test import discovered during GREEN was removed.

## Parent gateway integration evidence

Parent built the current gateway binary and ran `browser-control/tests/rust-gateway.test.mjs`, without changing source. Full contract run: 68/70 pass; one setup-readiness timeout in the first "WDA recovery waits for readiness..." subtest also caused its parent test to count failed. Log: `/tmp/wda-diagnostics-gateway-contract.log` (205874ms). This is not claimed as a clean full-suite pass.

The parent then reran only "WDA recovery waits for readiness and a fresh observation without replaying an uncertain tap": both "native WDA timeout" and "interrupted native response" plus parent passed, 3/3, zero failure, with no intervening source changes. Log: `/tmp/wda-diagnostics-gateway-recheck.log` (14325ms). Other 68 full-run tests covered SDK/session/close contract paths. No broad JS test suite was run for Task 1; JavaScript behavior was not changed.

## Privacy, limitations and review

New events contain fixed categories, IDs, counters, durations and sample ages. They do not add screenshots, input text, request bodies, URLs/query tokens, raw phone log bodies, process listings/paths, credentials or pairing data. Observer storage is bounded to one runner snapshot, one process observation, latest completed/last-success health probes and one latest skip. Writes remain synchronous in-memory and tracing goes through the existing bounded nonblocking sink.

Synthetic tests prove typed delivery, classifications, socket retirement, callback progress, cancellation, stale ages and first-reason preservation. They do not prove phone-specific support for another DVT socket or establish an actual historical phone crash. The final process sample may predate an XCTest disconnect; no final probe or teardown delay was added. Unsupported/failed monitoring remains unknown until a new runner. The guide records these limits and a real-device acceptance checklist.

Independent spec/quality review is assigned to the parent after the scoped local commit. Task 1 diff package is `/tmp/wda-diagnostics-task-1.patch`, generated from the recorded feature baseline. Parent's later boundary design/plan documents remain untracked and excluded.

## Task 1 review follow-up

Both findings from `.superpowers/sdd/task1-review-report.md` are addressed in a scoped follow-up on top of `1fb9700`; that later-task design/plan commit is preserved. Only the runner event emitter/regression, this report, and the diagnostic guide change.

P2: `xctest_exit_summary.requested_cleanup` is replaced by `local_cleanup_attribution`. A known explicit local stop reason emits `requested`; a missing reason or sticky Unattributed fallback emits `unknown`. There is no negative/unrequested category and no inference of spontaneous phone-process death. Gateway transport cancellation can precede native SIGTERM/daemon stop. The guide now documents gateway_close → transport_error → daemon_stop as a valid requested-cleanup sequence and requires correlation with the gateway's first known reason. No shutdown IPC, teardown delay, cancellation behavior or policy change was introduced.

The existing production summary log was extracted into `emit_exit_summary` so the regression exercises the same emitter used by the runner. Before the fix, the test dropped the gateway side of a duplex transport and observed its read error while native stop delivery was deliberately delayed. Its tracing Layer captured the actual emitted `xctest_exit_summary` fields, including `requested_cleanup=false`; the assertion for `local_cleanup_attribution=unknown` failed. After GREEN, it verifies emitted unknown for missing/Unattributed reasons, absence of the old Boolean, requested for a later known local reason on the same runner, and that the earlier emitted event remains unknown.

RED log: `/tmp/wda-diagnostics-review-red.log`.

```text
transport_closes_before_native_stop_emits_unknown_local_attribution ... FAILED
emitted transport-before-stop evidence: {... "category": "socket_error", "event": "xctest_exit_summary", "requested_cleanup": "false", ...}
left: None
right: Some("unknown")
test result: FAILED. 0 passed; 1 failed
```

P3: the guide's `wda_health_failed` field list no longer includes `elapsed_ms`; duration is explicitly documented on `wda_health_completed.duration_ms`.

Focused RED and GREEN command:

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --locked -p ictl-wda --lib transport_closes_before_native_stop --offline
```

GREEN: 1 passed, 0 failed. Log: `/tmp/wda-diagnostics-review-green.log`.

Follow-up verification:

```bash
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --locked -p ictl-wda --lib --offline
cargo +1.90.0 --config 'source.crates-io.replace-with="rsproxy-sparse"' test --locked -p iphone-control --bin iphone-control phone_logs --offline
cargo +1.90.0 fmt --package ictl-wda --package iphone-control --check
git diff --check
```

Passed: WDA 89/89 (`/tmp/wda-diagnostics-review-wda.log`), app logging 1/1 (`/tmp/wda-diagnostics-review-app.log`), formatting and diff checks. The same Cargo duplicate-config warning and 10 existing apple-codesign dependency warnings remain; no new source warnings appeared. Vendor code and provenance did not change, and no broader JS or boundary work was run. Independent re-review remains the parent's final gate.
