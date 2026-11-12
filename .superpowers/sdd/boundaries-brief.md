### Task 1: Enforce capture, lifetime and ownership boundaries

**Files:**
- `crates/ictl-daemon/src/config.rs`, `tools.rs`, `core.rs`, `lib.rs` and corresponding tests.
- `crates/ictl-wda/src/client.rs` only for explicit bounded capture selection.
- `crates/ictl-protocol/src/lib.rs` for the internal deadline constant/helper and strict metadata contract.
- `crates/ictl-gateway/src/gateway.rs`, `native.rs`, `controller.rs`, `tasks.rs`, plus a focused `control.rs` for admission leases if needed.
- `browser-control/tests/rust-gateway.test.mjs`, existing native/SDK fixtures only where needed by behavioral regressions.
- Extend `docs/dev/wda-diagnostic-logging.md` with new rejection events and operating limits.

**Interfaces:**
- An explicit native capture policy selected by the gateway; WDA single-frame transport keeps its existing 8-second/2-MiB limits.
- An optional validated native action deadline using same-host `CLOCK_MONOTONIC`, independent of wall-clock changes; no-field clients retain local stale checking.
- Separate public-manual versus internal-task command entry paths backed by a session arbiter. Jobs own their admission permit until completion/drop, including cancelled tasks' queued work.

- [x] **Step 1: Capture RED.** Add tests that fail on WDA MJPEG error followed by CoreDevice PNG fallback, and on bounded remote HID-orientation capture. Assert that the fallback provider was never called and the original capture failure remains available. Add local-mode success coverage. Run focused daemon/WDA tests before implementation.
- [x] **Step 2: Capture GREEN.** Make policy explicit in native config and always set bounded-remote from the cloud gateway. Apply it inside both WDA capture selection and shared CoreDevice PNG capture entry. Preserve errors; emit a fixed rejection category. Keep unrelated latency settings independent and document the new native setting.
- [x] **Step 3: Deadline RED.** Write behavioral tests with old gateway queue timestamps and split queue budgets; assert expired side effects never reach the native fixture. Add native parser tests for absent, valid, malformed, elapsed and excessively future deadline metadata, plus duplicate-ID no-renewal tests. Use injected/paused timing or old timestamps rather than real 30-second sleeps.
- [x] **Step 4: Deadline GREEN.** Anchor the deadline at first gateway command admission, store it with the job, validate after readiness waits, carry it through IPC, and compare again after the daemon device lock. Use the earliest of local protection and the upstream deadline. Validate clock conversion/overflow and log rejection stage with the existing diagnostic correlation. Read-only operations need no action deadline.
- [x] **Step 5: Ownership RED.** In real gateway fixtures hold the model request or confirmation pending, send a direct manual tap and launch-app request, and expect 409 with zero extra device actions; status still succeeds. Verify owning task actions, task release, queued-manual versus task-admission races, cancellation and duplicate-ID behavior. Run these tests against the current implementation before adding arbitration.
- [x] **Step 6: Ownership GREEN.** Introduce session-owned atomic admission. Manual mutation jobs hold a permit from admission through completion; task lifetime holds an exclusive typed lease, task jobs retain it as required. Update TaskManager start/run/finish/stop paths and all mutation dispatch paths. Never authorize an external request by a body task ID, and never infer exclusivity solely from serialized execution or UI disabled controls.
- [x] **Step 7: Verification and docs.** Run affected Rust library/protocol/app tests, focused Clippy and format checks, and the real gateway contract suite. Inspect diagnostic logs for data leakage and all new error paths for no replay. Update guide/spec with observed command outputs and any compatibility limit.
- [x] **Step 8: Commit and independent review.** Commit locally after verification, report exact changes and RED/GREEN evidence to `.superpowers/sdd/boundaries-report.md`, and request an independent review of the full code path before completion. No push or deployment.

## Current state

Capture, deadline and ownership implementations are in place on top of reviewed diagnostic HEAD `278b9b5`. HTTP ingress includes body wait; native-only resign uses its separate lock check. Setup and WebSocket pairing setup also retain manual admission. Focused actual gateway boundary contracts pass, including rejection without session/task cancellation. Final Rust (201 tests), app logging (1 test), Clippy and format checks pass. The parent's final full gateway run passed 79/79 and independent spec/code-quality review approved the implementation. Implementation commit: `50427f5`; exact metadata is recorded in the boundaries report. No push, deployment, VPS write or real-device action.
