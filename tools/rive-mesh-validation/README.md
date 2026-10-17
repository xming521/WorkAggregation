# Synthetic Rive raster-mesh diagnostic

One authorized GitHub Actions run on the exact test branch, using the free standard Ubuntu runner in this public repository. Do not push further commits to this branch or re-run without reviewing the outcome and obtaining approval for another run.

The 2,617-byte fixture is synthetic: a fixed image on the left and a 15-vertex deforming copy on the right. No production character is included. SHA-256: `d1f08d04b78add9d2f95040f24c2b9458bc44160129f5b9aab7344f4c6588248`.

The test uses official Rive canvas-lite, canvas, and WebGL2 runtimes 2.44.2, with pinned dependency integrity hashes. Runtime code is downloaded from npm rather than vendored; its upstream MIT licenses remain in the installed packages. Playwright runs Chromium with its sandbox explicitly enabled and unsafe fallback defaults filtered. The actual command line and graphics capabilities are recorded. No software-renderer security bypass is enabled.

`evidence/report.json` is authoritative. A successful diagnostic job or an asset's Loaded event does **not** mean mesh rendering passed. Only `pixel_verified` means the captured frames satisfy visible image, fixed reference, moving mesh, local bend, and closed loop assertions. A missing graphics context or unavailable sandboxed browser is an environment diagnosis. Frames are captured at 0, 1, 3 and 4 seconds, not placeholder illustrations.

This is a limited synthetic acceptance test, not a production character or deployment certification. Browser/runtime errors and failed requests are preserved. The workflow has one job, a ten-minute timeout, no schedule, and no privileged secrets.

Free-runner policy checked: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
