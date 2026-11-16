# Device workspace UI

Redesign the browser device console as a task-focused AI workspace, using affectUI Clean primitives and the UI/UX Pro Max AI-Native UI pattern. Keep the Rust/Leptos/WASM stack and existing device protocols.

## Layout

- A compact header contains branding, connection status and the settings entry.
- Connection parameters live in a native, on-demand dialog. Fields remain mounted while the dialog is closed.
- The left pane contains execution history above a compact task composer. Model selection, image attachments and optional automatic confirmation sit in the composer toolbar.
- The right pane is a dedicated device canvas with preview controls, hardware buttons and text entry. The disconnected state shows guidance directly on the canvas without a simulated phone screen.
- Preparation output remains below the workspace so setup continues to be usable after closing connection settings.
- Use neutral light surfaces, restrained indigo primary actions, consistent decorative SVG icons and semantic status colors.

## Interaction and state

- Preserve native dialog focus containment, Escape dismissal and focus restoration to its trigger. Closing settings does not disconnect the device.
- Dispatch USB selection directly from the connect click event, before asynchronous work.
- Preserve token clearing, connection cancellation/cleanup and session identity checks.
- Preserve model selection, reference-image uploads/removal, automatic confirmation policy, goal updates, Continue, confirmation and independent Stop dispatch.
- Preserve iPhone setup, Android controls, on-demand capture, live-preview start/stop, rotation, gesture mapping and image-node identity.
- Show only actual device/session/task data. Keep offline controls disabled and task state accessible by text as well as color.

## Responsive and accessible behavior

- Keep separate named execution, composition and preview regions, with a keyboard skip link and labelled controls.
- Reserve visible space for the execution header and Stop. A desktop composer with many attachments, expanded options or a resized textarea scrolls within its allocated area.
- On small screens, panes stack in task-first order and the composer reflows. Controls remain reachable without horizontal document overflow.
- Use comfortable touch targets at phone/tablet widths and on coarse pointers. Respect text scaling and reduced-motion preferences.
- Empty-state guidance must fit its canvas at enlarged text sizes; preview content may scroll when necessary.

## Verification

Browser checks cover dialog focus/state, USB user activation, connection cleanup, model choice, reference images, goal updates, Continue, confirmation, Stop, frame identity, rotation and gesture mapping. Layout checks include 375px, 932px landscape and 1440px, enlarged text, long arguments and six-image composers with expanded options and a 260px textarea.

The optimized WASM and production assets were built. All 27 browser UI tests passed. The full browser-control regression recorded 202 passes and 65 gateway-contract skips because their test binary was not supplied. Independent review and screenshot inspection found no remaining concrete issue after the layout fixes. Real-device integration was not exercised in this UI change.

Target branch: `release-20261112-performance`.
