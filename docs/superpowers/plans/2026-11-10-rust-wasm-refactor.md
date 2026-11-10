# Rust/WASM Browser Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the project's browser UI and control logic to Rust/WASM while retaining third-party SDKs through a thin JS bridge.

**Architecture:** A new `ictl-web` workspace crate owns browser behavior and the Leptos CSR UI. WASM exports preserve existing behavioral test entry points through JS reexports. Third-party iPhone, Tango ADB and scrcpy objects remain at a narrowly defined JS boundary.

**Tech Stack:** Rust 1.90 tooling, wasm-bindgen, web-sys, serde, Leptos CSR, existing Vite packaging and Node protocol tests.

## Global Constraints

- User approved scheme A on 2026-11-10. Project-owned UI, state, HTTP, gestures, Android commands, relay and frame management migrate to Rust/WASM. Third-party SDKs remain behind JS bridges.
- Keep macOS desktop Chrome, HTTPS/localhost, same USB chooser activation chain, existing HTTP/WebSocket contracts, `/iphone/` asset base and per-session credential handling.
- Preserve cancellation cleanup, delayed SDK completion, stale-response guards, USB packet boundaries, one-dispatch actions, independent stop requests, model selection, Android Unicode paste and orientation validation.
- Reuse CSS and product flows. Retain existing protocol/gateway fixtures and distinguish fake-device tests from physical-device evidence.
- Work on `codex/rust-wasm-refactor`, based on `e1e3bb46b85ffff1d859dc4e7ce6c014036df41f`.
- Baseline toolchain is invoked explicitly with `+1.90.0`; local registry override is passed on the command line rather than committed.

## Task 1: Browser runtime, device adapters and WASM exports

**Files**

- Create `crates/ictl-web/Cargo.toml`, `src/lib.rs`, `src/identity.rs`, `src/interaction.rs`, `src/packets.rs`, `src/client.rs`, `src/polling.rs`, `src/actions.rs`, `src/android/{mod,commands,relay,video}.rs` and focused tests.
- Modify root `Cargo.toml`/`Cargo.lock` to add the workspace crate.
- Modify `browser-control/web/{client,interaction,polling,task-actions,usb-packets}.mjs`, `web/android/*.mjs`, `src/device-identity.mjs` to become SDK bridges or Rust reexports.
- Create `browser-control/web/wasm.mjs` and `scripts/build-wasm.sh`, adjust package scripts to build WASM before tests and production builds.

**Interfaces**

- Consume the exact existing APIs exercised by `browser-control/tests/*.test.mjs`.
- Produce Rust WASM `BrowserClient` matching the existing constructor injection and methods `snapshot`, `subscribe`, `connect`, `disconnect`, `update`, `config`, `refresh`, `screen`, `command`, `startSetup`, `setupInput`, `startTask`, `confirmTask`, `stopTask`; `fetchImpl` remains injectable for behavioral tests.
- Export `canonicalUID`, `toPhonePoint`, `pointerCommand`, `completeUsbPacketReads`, `startSessionPolling`, `createTaskActions`, and Android test APIs under their current JS names.
- Build web bindings under `browser-control/pkg/` and Node test bindings under `browser-control/pkg-node/`; generated files are ignored.
- Expose `BrowserClient` to the UI through the Rust crate, and supply SDK defaults through bridge imports. The UI can request the initialized SDK options from the JS bridge.

- [ ] Add a behavioral regression invoking a Rust-exported gesture or identity function and confirm it fails while the export is absent.

```js
assert.equal(wasm.canonicalUID('00008140001234567890abcd'), '00008140-001234567890ABCD');
assert.equal(wasm.toPhonePoint(25, 110, {left:20,top:10,width:200,height:200},100,200), null);
```

- [ ] Add native Rust tests for packet fragmentation and identity/coordinate edge cases, then implement the tested Rust core.
- [ ] Implement browser state and SDK calls in Rust, porting existing cancellation and timing cases through the current tests. Observe failures before replacing each implementation.
- [ ] Implement Android command mapping, relay and video management through the same behavioral tests. Keep dependency-specific SDK construction and stream bindings in JS.
- [ ] Run `cargo +1.90.0 test -p ictl-web`, web and Node WASM builds, and Node runtime/protocol tests. Expected result is passing migrated behavior tests with explicit reasons for any temporary UI-only integration gap.
- [ ] Commit task files and record commands, counts, remaining integration requirements and bridge boundaries in `.superpowers/sdd/task-1-report.md`.

## Task 2: Rust UI and production integration

**Files**

- Create `crates/ictl-web/src/ui/{mod,connection,preview,setup,task}.rs` and Rust view helpers as needed.
- Replace `browser-control/web/main.tsx` with a WASM bootstrap `web/main.mjs`; remove replaced React components, TS declarations and obsolete React-only dependencies.
- Update `browser-control/index.html`, `package.json`, lockfile, `vite.config.mjs`, `Dockerfile`, `.gitignore`, `THIRD_PARTY.md` and build documentation for the actual Rust frontend entry point.
- Update `crates/ictl-gateway/src/static_files.rs` to serve `.wasm` as `application/wasm`, with regression coverage of GET/HEAD MIME and missing-asset handling through the real gateway.
- Replace React SSR tests with browser-facing tests of the Rust UI and retain shared gesture/runtime coverage.

**Interfaces**

- Consume Task 1's `BrowserClient` and initialized SDK options, its state notifications and Promise methods.
- Produce an exported `mount` function invoked by `web/main.mjs` after WASM initialization, mounting into `#root`.
- Preserve existing classes, labels, form lengths, model selection and busy/stop behavior from `App.tsx` and the four TSX components.

- [ ] Write a normal-entry browser regression expecting the WASM-mounted device console, disabled offline control, model picker, task input and connection selector. Confirm failure before replacing React.
- [ ] Implement the Leptos UI with the existing CSS. Keep the image DOM element stable while refreshing screenshots so pointer capture and text input survive status updates.
- [ ] Ensure USB selection is invoked directly inside the click handler and clear token/setup inputs synchronously when submitted.
- [ ] Replace production entry and package dependencies, update Vite WASM packaging and Docker build prerequisites. Keep source-path and `/iphone/` builds valid.
- [ ] Confirm the built WASM asset loads from the Rust static server with the correct MIME type and passes the existing traversal/missing-file guards.
- [ ] Run Rust core tests, browser runtime/protocol tests, Rust UI browser regressions, production builds and format/lint checks. Inspect the rendered Chrome page and browser console.
- [ ] Commit task changes and record complete results in `.superpowers/sdd/task-2-report.md`.

## Task 3: Whole-branch verification and handoff

- [ ] Review the entire diff against the approved specification and resolve Critical/Important findings.
- [ ] Run fresh `cargo +1.90.0 test -p ictl-web`, `cargo +1.90.0 test --locked -p ictl-gateway`, Node tests with `RUST_GATEWAY_BIN` set to the built gateway, production WASM builds and browser tests.
- [ ] Check generated assets and licenses are served by the Rust gateway under the supported base path.
- [ ] Update the verification record with exact automated and physical-device coverage, retained JS boundary and build prerequisites.
- [ ] Push verified commits on the requested branch and report branch URL, outcomes and remaining hardware/platform validation.
