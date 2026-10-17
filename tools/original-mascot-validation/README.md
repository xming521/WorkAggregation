# Original mascot component validation

This fixture production-builds the real `PilotMascot`, `CalendarHaruPresentation`, and `DesktopHaruWindow` components and bundled character assets. Only the desktop bridge is fake. It never starts the backend or calls a provider. The HTTP server sends the actual desktop `contentSecurityPolicy` without weakening it. Browser requests are restricted to the fixture origin; API and external requests fail the run.

## Run

From the repository root:

```sh
npm ci --prefix web
npm ci --prefix tools/original-mascot-validation --ignore-scripts
npm test --prefix tools/original-mascot-validation
npm run build --prefix tools/original-mascot-validation
npm run validate --prefix tools/original-mascot-validation
```

Validation requires installed Google Chrome and a working browser sandbox/graphics stack. It uses Playwright 1.62.1 with `channel: chrome`, `chromiumSandbox: true`, and removes unsafe default arguments. Actual browser-process arguments are independently checked before any page runs. Browser startup/graphics failure is a failed validation, never permission to weaken security. Do not retry with no-sandbox, unsafe SwiftShader, or ignored security checks.

## Evidence

`evidence/report.json` records source asset hashes, exact runtime/browser versions, launch security diagnostics, component screenshots, genuine canvas alpha and eight timeline samples, isolated fallback cases, bridge actions, context replacement, timer/RAF/canvas cleanup, transfer sizes, and matching four-second collapsed-idle samples for the legacy renderer, original animation, and original static image. Collapsed desktop viewport is the real 260×340 DIP; expanded is 420×740. Device pixel ratio, CSS size and drawing-buffer size are recorded. Unique RAF timestamps that actually clear the visible canvas measure rendering-clear cadence as a submission proxy, not presented screen FPS or source/export frame rate. TaskDuration is not OS CPU, GPU, or native-window performance; JSHeapUsedSize is not total-process memory. The workflow verifies system Chinese-font coverage and installs only the official Ubuntu fonts-noto-cjk package when missing. Font inventory is saved with the screenshots. Network transfer sizes include browser caching behavior.

Coverage includes light/dark collapsed desktop and web character views, static expanded chat, expand/collapse/show-main actions, all three components switching legacy → original → legacy with distinct acquired canvas contexts (legacy pixel correctness is not asserted), reduced motion, animation off, unavailable graphics, malformed Rive bytes, real private offscreen WebGL2 loss via `WEBGL_lose_context`, synthetic canvas context-loss events, and injected empty-readback health failure. The empty-readback case intentionally replaces canvas pixel readback to exercise the production health monitor; it is not a real device-loss experiment. Whole-canvas animation change is asserted; semantic blinking is left to visual review rather than inferred from arbitrary changed pixels.

The fixture imports source components through Vite's production build. It is not the full application, a packaged native executable, real desktop IPC, a Windows test, or release acceptance. No backend/provider calls, publish, deploy, release, or account changes are part of this harness. The workflow is restricted to the dedicated preview branch, has a ten-minute bound, and retains evidence for seven days.
