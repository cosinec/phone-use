# WebUSB Cloud Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a browser-owned USB channel into the existing iPhone control engine, plus a task website and configurable cloud AI.

**Architecture:** A Node server hosts a per-browser virtual usbmuxd service and an unchanged iphone-control daemon; Chrome uses the published Limrun WebUSB SDK to relay streams. The same server serves the React website, authenticates sessions and runs the bounded AI loop. Cloud deployment is a native Linux service behind HTTPS, not a browser-local daemon.

**Tech Stack:** Node 22.13+, ESM, ws 8.22.2, plist 5.1.0, @limrun/device-install 0.1.0, React 19.2.6, Vite 8.0.13, existing iphone-control v0.1.4/compatible main.

## Global Constraints

* Client: macOS Chrome, real WebUSB, HTTPS or localhost; no user-machine helper.
* No changes to existing Rust code; native process runs on the server.
* Keep Apple/model/session credentials out of source and access logs; `.runtime/` is ignored.
* One virtual mux/native daemon per session; token/origin checks and bounded buffers; no action retries after transmission.
* Reuse Limrun SDK public API/relay wire format and PR #34 interaction behavior; preserve attribution.
* Tests must label fake peer/native fixtures; no physical-device claims from mocks.
* Read `docs/superpowers/specs/2026-11-09-webusb-cloud-control-design.md` for exact REST/wire contracts.

---

### Task 1: SDK-compatible cloud USB gateway and native adapter

**Files:** `browser-control/src/{relay-protocol,virtual-usbmuxd,native-controller,commands,gateway,server}.mjs`, `browser-control/tests/{relay,virtual-usbmuxd,native-controller,gateway}.test.mjs`, `browser-control/tests/fixtures/native-cli.mjs`.

**Consumes:** Published SDK frame schema and existing serde `Request`/`Response` protocol from `crates/ictl-protocol/src/lib.rs`.
**Produces:** `createGateway(options)` plus the sessions/setup/command/screen API above; `NativeController` construction via session config; `commandRequest(tool,args)`; `encodeFrame/decodeFrame`; `createVirtualMux({device,openStream,onPairRecord,pairRecord?})` returning loopback address and close.

- [ ] Write behavior tests before implementation, including a real loopback mux connection and an SDK-shaped WebSocket peer. Initial test:
  ```js
  import test from 'node:test'; import assert from 'node:assert/strict';
  import { encodeFrame, decodeFrame } from '../src/relay-protocol.mjs';
  test('binary relay frames preserve stream id and payload', () => {
    const frame={type:4,requestId:7,streamId:9,payload:Buffer.from([0,255,1])};
    assert.deepEqual(decodeFrame(encodeFrame(frame)),frame);
  });
  ```
- [ ] Run `node --test tests/relay.test.mjs`; record the expected missing-module RED result.
- [ ] Implement the frame codec and virtual mux, then native CLI lifecycle, then gateway. Use little-endian usbmuxd headers and big-endian relay headers; never infer frame boundaries from a TCP `data` event.
- [ ] Add and run tests for native fixture subprocess, setup input, token/origin checks, two-session isolation, closed stream behavior, lost WebSocket and request id deduplication: `npm test`.
- [ ] Self-review and commit only task files; write detailed report/TDD evidence under `.superpowers/reports/task-1.md`.

### Task 2: Cloud AI task controller

**Files:** `browser-control/src/{model-client,task-runner}.mjs`, gateway integration, `browser-control/tests/{model-client,task-runner}.test.mjs`.

**Consumes:** `session.screen()`, `session.runCommand({requestId,deviceId,tool,args,signal?})`, `session.device.serialNumber`, `session.abort.signal` and gateway session lifecycle. Configure compatible model endpoint/key/model through server environment.
**Produces:** `TaskRunner` with `start(instruction)`, `stop(taskId)`, `confirm(taskId,actionId,approved)`, `snapshot()`; model action schema `{type:'action',tool,args,reason,requiresConfirmation}` or `{type:'done',message}`.

- [ ] Write an async test that holds a model promise, stops the task, resolves an action, and asserts zero subsequent commands:
  ```js
  let release; const model=()=>new Promise(r=>release=r); const calls=[];
  const session={device:{serialNumber:'00008130-0000000000000001'},abort:new AbortController(),screen:async()=>({elementsText:'Home'}),runCommand:async x=>calls.push(x)};
  const runner=new TaskRunner({model,session});
  const task=runner.start('open settings'); await new Promise(r=>setImmediate(r));
  assert.equal(typeof release,'function'); runner.stop(task.id);
  release({type:'action',tool:'iphone_press_button',args:{button:'home'},reason:'home'});
  await new Promise(r=>setTimeout(r,20)); assert.equal(calls.length,0);
  ```
- [ ] Run the focused test and record RED before production code.
- [ ] Implement bounded observation→model→validate→confirm/execute loop, generation cancellation, structured history and terminal errors. Return explicit AI-not-configured errors.
- [ ] Verify JSON parsing, invalid actions, model redirect/timeout, confirmation, limits, duplicate task starts and stop while waiting/executing. Run focused tests then `npm test`.
- [ ] Self-review, commit, and report under `.superpowers/reports/task-2.md`.

### Task 3: Browser UI, real SDK integration and distribution

**Files:** `browser-control/web/{main.tsx,App.tsx,styles.css,client.mjs,types.ts}`, optional focused `web/components/{ConnectionPanel,PhonePreview,TaskPanel,SetupPanel}.tsx`, `browser-control/index.html`, `browser-control/vite.config.mjs`, `browser-control/tests/browser-client.test.mjs`, `browser-control/{README.md,THIRD_PARTY.md,Dockerfile,compose.yaml,.env.example}`, scripts and root readme link.

**Consumes:** REST/wire contracts from Tasks 1/2; SDK `requestUSBAccess`, `pairDevice`, `closeDeviceRelayTarget`, browser pair store.
**Produces:** Browser web app showing live session readiness, connect/pair/setup wizard, setup inputs, screenshots/point clicks, Home/Lock/text controls, natural-language task, progress, confirmation and stop. Package imports the published SDK, not reimplemented USB.

- [ ] Write wrapper tests with SDK injection for selecting device, pairing exactly once, passing returned session token, avoiding auto-retry on commands, and cleanup. Run RED.
- [ ] Implement `BrowserClient`/React UI; use real `navigator.usb` through SDK and make all unauthenticated/missing-device/model states explicit. No fake device shown by default.
- [ ] Adapt PR #34 pointer coordinate math with attribution; screenshots use points returned by the native engine.
- [ ] Add native Linux Docker/reverse-proxy deployment and local development instructions, browser compatibility and real-device acceptance checklist. Environment example contains names/placeholders only.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`; inspect local website at desktop/mobile widths via CUA and complete the CUA summary before other tools.
- [ ] Broad independent review, fixes, fresh checks, source archive in task outputs, final report with branch/commits and physical-device limits.

## Self-review

All approved browser/cloud/USB roles map to Tasks 1–3. Exact SDK route, wire byte order, native CLI environment, credential location and stop semantics are defined above. AI credentials and attached hardware are deployment/test inputs; neither is fabricated. Execution proceeds in this already isolated task-owned clone on the new branch.
