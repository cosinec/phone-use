# Control Boundary Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Enforce bounded remote screenshots, a single action lifetime, and exclusive task control through all server-side dispatch layers.

**Architecture:** Capture policy is explicit and applied at both WDA selection and CoreDevice entry. A same-host monotonic expiry field crosses native IPC. A session-owned typed lease arbitrates task/manual mutation admission and accompanies queued work.

**Tech Stack:** Rust 1.90, existing Tokio/serde/libc dependencies, existing native and gateway fixtures.

## Global Constraints

- Preserve the WDA diagnostic changes and the 3-failures/60-second restart policy.
- Remote capture must never download ordinary WDA PNG or CoreDevice PNG, including implicit HID orientation captures. Local fallback remains available.
- Action admission lifetime is 30 seconds total across gateway and native queues; no lower layer or retry renews it.
- Task ownership covers observing, thinking, recovery and confirmation. Manual mutations return 409 while a task owns the session; safe status stays available.
- Internal deadlines and task leases cannot be supplied or extended through browser request JSON.
- No raw payload logs, replay of sent actions, global configuration edits, VPS writes or upstream video-stack merge.

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

- [ ] **Step 1: Capture RED.** Add tests that fail on WDA MJPEG error followed by CoreDevice PNG fallback, and on bounded remote HID-orientation capture. Assert that the fallback provider was never called and the original capture failure remains available. Add local-mode success coverage. Run focused daemon/WDA tests before implementation.
- [ ] **Step 2: Capture GREEN.** Make policy explicit in native config and always set bounded-remote from the cloud gateway. Apply it inside both WDA capture selection and shared CoreDevice PNG capture entry. Preserve errors; emit a fixed rejection category. Keep unrelated latency settings independent and document the new native setting.
- [ ] **Step 3: Deadline RED.** Write behavioral tests with old gateway queue timestamps and split queue budgets; assert expired side effects never reach the native fixture. Add native parser tests for absent, valid, malformed, elapsed and excessively future deadline metadata, plus duplicate-ID no-renewal tests. Use injected/paused timing or old timestamps rather than real 30-second sleeps.
- [ ] **Step 4: Deadline GREEN.** Anchor the deadline at first gateway command admission, store it with the job, validate after readiness waits, carry it through IPC, and compare again after the daemon device lock. Use the earliest of local protection and the upstream deadline. Validate clock conversion/overflow and log rejection stage with the existing diagnostic correlation. Read-only operations need no action deadline.
- [ ] **Step 5: Ownership RED.** In real gateway fixtures hold the model request or confirmation pending, send a direct manual tap and launch-app request, and expect 409 with zero extra device actions; status still succeeds. Verify owning task actions, task release, queued-manual versus task-admission races, cancellation and duplicate-ID behavior. Run these tests against the current implementation before adding arbitration.
- [ ] **Step 6: Ownership GREEN.** Introduce session-owned atomic admission. Manual mutation jobs hold a permit from admission through completion; task lifetime holds an exclusive typed lease, task jobs retain it as required. Update TaskManager start/run/finish/stop paths and all mutation dispatch paths. Never authorize an external request by a body task ID, and never infer exclusivity solely from serialized execution or UI disabled controls.
- [ ] **Step 7: Verification and docs.** Run affected Rust library/protocol/app tests, focused Clippy and format checks, and the real gateway contract suite. Inspect diagnostic logs for data leakage and all new error paths for no replay. Update guide/spec with observed command outputs and any compatibility limit.
- [ ] **Step 8: Commit and independent review.** Commit locally after verification, report exact changes and RED/GREEN evidence to `.superpowers/sdd/boundaries-report.md`, and request an independent review of the full code path before completion. No push or deployment.
