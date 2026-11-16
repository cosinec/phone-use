# Device Workspace Implementation Plan

> Use executing-plans for the coupled UI changes and requesting-code-review for an independent read-only review.

**Goal:** Deliver a task-focused browser workspace with on-demand connection settings, a compact composer and a dedicated device canvas.

**Architecture:** Keep `Ui` state/actions and browser/device protocols unchanged. Separate task composition from execution rendering, share decorative SVG icons and use a native connection dialog.

**Tech stack:** Rust 1.90.0, Leptos, wasm-bindgen 0.2.130, CSS, Vite and Playwright.

## Files and interfaces

- `crates/ictl-web/src/ui/mod.rs`: header, workspace layout and component placement.
- `crates/ictl-web/src/ui/connection.rs`: `ConnectionDialog(ui: Ui)`, `open_connection_settings()` and existing connection controls.
- `crates/ictl-web/src/ui/task.rs`: composition, models, images and optional task controls.
- `crates/ictl-web/src/ui/progress.rs`: `TaskProgress(ui: Ui)`, execution history, goal updates, confirmation and Continue.
- `crates/ictl-web/src/ui/icons.rs`: shared decorative `Icon(name: &'static str)`.
- `crates/ictl-web/src/ui/preview.rs`, `setup.rs`, `attachments.rs`: accessible presentation changes while preserving actions.
- `browser-control/web/styles.css`: semantic tokens, pane allocation, responsive reflow, focus and motion rules.
- `browser-control/index.html`: document metadata.
- `browser-control/tests/browser-ui.test.mjs`: behavioral and layout regression checks.

## Completed implementation

- [x] Verify the release-branch baseline and add failing tests for named regions, keyboard navigation and mobile controls.
- [x] Extract execution rendering without changing Stop, confirmation, goal-update or Continue calls.
- [x] Replace the sidebar/form layout with a compact header, native settings dialog and two working panes.
- [x] Move models, reference images and automatic confirmation into the composer toolbar.
- [x] Add failing regressions for dialog focus/restoration and execution above a composer reachable in the first desktop viewport.
- [x] Reproduce and fix composer growth covering Stop, including six uploaded images, expanded options and a 260px textarea.
- [x] Reproduce and fix enlarged empty-state guidance clipping inside the phone frame.
- [x] Verify responsive layouts, enlarged text, reduced motion and actual pointer hit testing for Stop.
- [x] Complete independent read-only review and resolve confirmed findings.
- [x] Build optimized WASM, generate browser/Node bindings and build production assets.

## Validation

Commands used:

- `cargo +1.90.0 build --locked -p ictl-web --target wasm32-unknown-unknown --release`
- Generate browser and Node bindings with wasm-bindgen 0.2.130.
- `npm run build:assets` in `browser-control`.
- `node --test tests/*.test.mjs` in `browser-control`.
- `cargo +1.90.0 fmt -p ictl-web --check`
- `git diff --check`

The local Cargo registry override corrected the developer machine's obsolete mirror URL without changing repository configuration. Final regression: 202 passed, 0 failed, 65 gateway contracts skipped without `RUST_GATEWAY_BIN`; all 27 browser UI tests passed. Screenshot and independent-review checks covered normal/enlarged text at phone, landscape and desktop widths. Real-device integration remains outside this UI verification.
