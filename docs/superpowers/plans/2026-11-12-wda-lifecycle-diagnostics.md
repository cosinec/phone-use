# WDA Lifecycle Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Produce sufficient bounded evidence to distinguish phone process exit, WDA response failure, transport loss and deliberate shutdown.

**Architecture:** A typed optional diagnostic observer bridges idevice's launch/process observations to the runner. Native status carries independent observation metadata while existing readiness and restart decisions remain intact. Gateway and runner shutdown record their first explicit reason.

**Tech Stack:** Rust 1.90, Tokio, tracing, serde, the vendored idevice DVT stack; existing gateway and daemon tests.

## Global Constraints

- Base: `53fdfb2069c046a9d1c2dd8e8bac49425d0def13`; preserve existing controls and the 3-failures/60-second restart policy.
- Phone PID probes: 10-second delayed cadence, at most one in flight, 5-second setup/request bound; failure is unknown.
- Diagnostic observations older than 30 seconds must be distinguishable as stale.
- No raw phone messages, process listings/paths, images, request bodies, input text, credentials, pairing data or URL/query tokens in new logs.
- No new external dependencies, automatic device action replay, detached monitor tasks, VPS writes or deployment.
- Preserve first shutdown cause and correlate native process generation, runner and phone PID.

### Task 1: Correlated WDA interruption evidence

**Files:**
- Modify `vendor/idevice/src/services/dvt/xctest/mod.rs`, `listener.rs` or a focused sibling `diagnostics.rs`, plus `vendor/idevice/provenance.json`.
- Modify `crates/ictl-wda/src/runner.rs`; add focused `crates/ictl-wda/src/diagnostics.rs` if needed and export through `lib.rs`.
- Modify `crates/ictl-daemon/src/core.rs`, `supervise.rs`, `lib.rs`; keep diagnostic state in a focused `diagnostics.rs` module if necessary.
- Modify `crates/ictl-gateway/src/gateway.rs` and its shutdown callers only for cause preservation.
- Adapt `apps/iphone-control/src/phone_logs.rs` if typed PID delivery replaces the old formatted-message bridge.
- Update `docs/dev/wda-diagnostic-logging.md`, `THIRD_PARTY.md` and focused existing tests as needed.

**Interfaces:**
- Consume the existing `XCUITestService`, DVT deviceinfo `is_running_pid`, `WdaRunner`, native `Snapshot`, and session cleanup lifecycle.
- Provide typed phone PID and optional process observations that the runner can record without parsing logs.
- Provide a serde-compatible optional status diagnostic record. Additive status fields must tolerate older data.
- Provide explicit stop reasons while retaining a default unattributed fallback for Drop/cancellation paths.

- [ ] **Step 1: Verify the baseline.** Run `cargo +1.90.0 test --locked -p ictl-wda -p ictl-daemon -p ictl-gateway --lib`. Resolve local registry routing failures using invocation-local Cargo configuration; do not edit global Cargo settings.
- [ ] **Step 2: Establish RED for process observations.** Add a synthetic DVT or channel fixture verifying a launch PID is delivered as data, a true response means running, a false response means not-running, and errors/malformed replies mean unknown. With a pending probe, deliver a lifecycle callback and verify it is processed before probe timeout; cancel the runner and verify no remaining polling task. Execute the focused tests and record expected failures before implementation.
- [ ] **Step 3: Implement process observation.** Use a typed optional observer with a default-disabled path for unrelated idevice clients. Publish PID as soon as launch succeeds, even if later authorization fails. Poll an independent deviceinfo channel on the existing DVT connection where supported. A timeout must not poison future replies; retire the diagnostic channel or disable monitoring until a new runner, reporting that limitation. Keep observer writes bounded and synchronous or use a bounded queue; never await disk IO.
- [ ] **Step 4: Establish RED for health and stop provenance.** Add tests for a successful probe followed by failure, last-success preservation, stale snapshots without completed probes, device-lock skips carrying active operation identity, and reset on runner replacement. Add a local-stop-then-socket-error test proving stop cause remains requested cleanup. Test that a gateway first close reason survives later cancellation. Run focused tests before implementation.
- [ ] **Step 5: Implement health records and stop provenance.** Record completed probe events with duration, classification, sequence, runner identity and last success age. Store observation metadata independently of the long-held device lock. Record busy skips with operation ID/tool name only; emit recovery transitions. Add explicit stop reasons at callers and preserve a gateway's first known close reason before cancellation. Status diagnostics expose sample times/ages and indicate staleness; no readiness or restart-policy change.
- [ ] **Step 6: Review privacy and boundedness.** Inspect every new event and diagnostic field; remove arbitrary payloads and unbounded error text. Update exact SHA256 provenance for each modified vendored source file. Extend the guide with the concrete event schema and interpretation, including unknown observations and browser-close cleanup.
- [ ] **Step 7: Verify GREEN.** Run affected crate tests and app logging tests, targeted vendor tests with feature flags used by the workspace, `cargo +1.90.0 fmt --check` limited to edited packages/files, and Clippy for affected packages. Existing dependency warnings must be reported precisely. Check `git diff --check`. Record command output and test counts in the task report.
- [ ] **Step 8: Commit and review.** Commit only this task's changes locally, prepare a diff package from the recorded baseline, and request independent spec/quality review. Fix confirmed issues with focused regression tests and re-review. Leave the work on `codex/wda-lifecycle-diagnostics` without pushing or deploying.
