# Preserve control guarantees across module boundaries

The user explicitly added three verified defects to the WDA diagnostics work. Fix these on top of the diagnostic implementation, with regression evidence and bounded rejection logs. No VPS deployment or upstream video-stack merge is requested.

## Remote capture policy

`capture_frame` currently turns WDA capture errors into `None`, then calls CoreDevice PNG on supported iOS. Add an explicit local versus bounded-remote capture policy. The cloud gateway must select bounded-remote for its native daemon, independently of optional low-latency timing tuning. Remote capture uses the existing bounded one-frame MJPEG capture and returns its error if unavailable/unsupported; neither ordinary `/screenshot` PNG nor CoreDevice PNG may be fetched as fallback. Enforce the policy at the shared CoreDevice screenshot entry as well, including implicit orientation captures used by HID fallback. Local native clients retain their existing fallback. Preserve the useful capture error. Add a fixed-category rejection log without image, request or phone data.

## Action expiry

Create the 30-second action admission deadline at gateway command entry, before readiness waits or queue admission. Carry it through the gateway job, native IPC, and daemon lock queue; never reset it at a lower boundary. Check immediately before device dispatch. Use a same-host monotonic deadline for gateway-to-daemon IPC (both are processes on the same host/container); wall-clock adjustment must not grant extra lifetime. Browser input cannot supply or extend this internal deadline. Daemon clients without the field retain the existing local 30-second stale-action protection. Invalid metadata is rejected, not treated as a missing deadline. Bound excessively future deadlines by the local maximum. Expiry rejects actions not yet dispatched; it does not replay or claim to undo an already sent action. Safe reads remain available. Correlate expiry stage, queue age and existing diagnostic ID without logging command arguments.

## Session control ownership

Session owns the arbiter for side-effect commands. A task holds a typed internal lease across observation, model calls, recovery and confirmation waits. Manual side-effect admission while a task owns the session returns 409 before executing or queueing the command. Task-origin commands prove ownership through an internal API/lease, never a client-supplied task ID. Do not merely check `tasks.active()` and release its lock before enqueueing: task acquisition and manual admission must be atomic with respect to ownership.

Pending/in-flight manual mutations prevent a task from acquiring control until they finish or are cancelled. Ownership must remain effective for queued/in-flight task jobs, survive stop races, and release on completion, failure, cancellation and session close. Duplicate request IDs keep no-replay behavior; retries cannot create a new lease or renew the deadline of a queued mutation. Status reads and cached preview remain available while a task runs. A caller who wants manual control must stop the task first; already sent actions retain the current uncertainty semantics. Do not introduce an unrelated UI takeover feature.

## Evidence and tests

Reproduce remote MJPEG failure with CoreDevice support available and assert no PNG fallback is called. Exercise the shared HID orientation capture path. Verify local fallback still works. Reproduce gateway queue age over 30 seconds and split waits across gateway/IPC/daemon whose sum exceeds 30 seconds while individual waits do not. Verify fresh actions dispatch once, expired actions dispatch zero times, malformed/future metadata cannot extend the budget, and duplicate IDs do not refresh it.

Use the real gateway fixture with a delayed model response and an awaiting-confirmation task: direct manual taps/app launches must be rejected, safe status must succeed, owning task actions must run, and manual actions must work after release. Race task admission against queued manual actions and cancellation; verify no stale-owner command runs. Run relevant Rust suites, protocol parsing tests and actual gateway HTTP/WebSocket regression.

## Upstream PR 42

Reviewed https://github.com/Derrors/iphone-control/pull/42 (merged head `4b865e5864216e4527269e2ccb09d1e6c73fa72c`). Its key change is device HEVC on iOS 27+, with host H.264/MJPEG alternatives; it does not update our pinned Rust `image` dependency. The reported `cpu_resource_fatal` incident is a hypothesis to verify against this phone's crash reports, not a diagnosis of our socket failures. The last observed phone runs iOS 26.5.2. Host encoding on the VPS would happen after JPEG crosses our browser-to-VPS link, so it cannot cure that uplink load. Keep on-demand bounded capture; do not import the new video stack in this change.
