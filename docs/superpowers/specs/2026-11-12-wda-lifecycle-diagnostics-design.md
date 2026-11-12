# WDA lifecycle diagnostics

The user approved implementing the preceding investigation's recommendation: correlate phone process liveness, WDA health, and session shutdown so a future interruption has evidence for its cause. This change instruments the existing lifecycle; it does not claim to establish a historical crash cause or deploy to the VPS.

## Evidence and scope

The reviewed baseline is `53fdfb2069c046a9d1c2dd8e8bac49425d0def13`. Existing `WdaRunner::alive()` only describes the local Tokio task. Health failures can retain `DeviceState::Ready`, and busy device operations skip the supervisor tick. Today the observed final sequence was browser close, daemon shutdown, then socket error: an exit error alone cannot establish that the phone process died first.

Use typed device process observations and bounded diagnostic events. Logging only local task state would preserve the ambiguity; continuously dumping iOS syslog or screenshots would add load and unrelated private data. Reuse the existing DVT connection when feasible, on an independent deviceinfo channel, without blocking XCTest callbacks. No new external dependency or service is needed.

## Required behavior

- Capture the phone PID directly from the XCTest launch result, not by parsing a formatted log message. Correlate new records with `native_pid`, `runner_id`, phone PID when known, and a native-start identifier that disambiguates container PID reuse. Existing session/namespace logs bridge the gateway and daemon.
- Observe the launched PID through the device's DVT deviceinfo service. Poll at most once every 10 seconds, allow at most one probe in flight, bound channel setup and requests to 5 seconds, and use delay scheduling without catch-up bursts. A false response is process-not-running evidence. Unsupported, malformed, failed, timed-out or missing responses are unknown, never proof of death. Do not log unrelated process lists or executable paths. Avoid silently reusing a channel with an ambiguous timed-out reply. Release monitoring when its owning runner ends; no detached polling tasks or new WDA launches.
- Record bounded, structured launch, process observation, XCTest callback/exit, health outcome, probe skip, and stop-reason events. Distinguish requested cleanup from unexpected return, and mark unknown/unattributed causes honestly. Events must preserve first-cause ordering, explicitly name the scope of an error, and never label socket failure as a phone crash without process evidence.
- Add an optional diagnostic snapshot to native status with last completed health probe, last health success, failure category/count, runner identity and last process observation. Keep timestamps and observation age available even when a probe is skipped; callers can recognize data older than 30 seconds as stale. Do not relabel existing readiness or change control authorization/restart behavior in this logging task.
- Make active device operation identity and supervisor skips observable without logging request bodies or holding the device lock just to update diagnostic metadata. Include recovery transitions, not only failure messages.
- Give explicit reasons to important stop paths: health restart, device replacement/offline, daemon shutdown, startup timeout/cancellation. Gateway closure records must retain a stable first reason for browser close, heartbeat/send failure, API deletion and server shutdown; cancellation must not overwrite a known reason.
- Preserve the current 3-failures/60-second restart policy, ordinary control timeouts, and no-replay guarantees. No screenshots, input text, credentials, pairing data, URLs/query tokens or raw phone log bodies are added. Existing bounded nonblocking log sink remains in use.

## Validation

Test structured PID delivery, true/false/unknown observations, timeout and cancellation, and continuation of XCTest dispatch while a process probe stalls. Test local cleanup followed by socket failure without misclassifying it as spontaneous phone death. Test successful/failed/skipped health observations and fresh/expired snapshots, including an occupied device lock and runner/session replacement. Test first-reason preservation for gateway cleanup. Run focused tests before implementation to establish RED, then relevant Rust regressions, formatting and Clippy. Update vendor provenance hashes for patched files and the diagnostic guide with event interpretation and a real-device acceptance checklist.

Synthetic tests prove classification, cancellation and logging behavior. A later deployed reproduction is still required to establish an actual phone crash or a device-specific DVT limitation.
