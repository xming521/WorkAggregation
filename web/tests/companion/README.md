# Companion synthetic Chromium acceptance

This bounded gate uses the production `web/dist` bundle and real Chromium, with
all HTTP assets and API responses fulfilled from local files or synthetic data.
It does not start a server, contact a backend/provider, use credentials, spend
model budget, or prove backend persistence, model quality or installed desktop UX.
Backend repository/chat tests remain separate evidence.

From the repository root:

```sh
npm ci --prefix web
node --test web/tests/companion/fixture.test.mjs
npm run build --prefix web
(cd web && npx --no-install playwright-core install --with-deps chromium)
node web/tests/companion/run.mjs artifacts/companion-browser
```

Do not retry Chromium in an executor where its socket/sandbox operation has been
denied. The branch/path-limited workflow provides the independent CI browser run.
It uses `contents: read`, disables persisted checkout credentials, and has no
provider, secret, deployment environment, dispatch or release step.

## What the gate checks

- Chinese at 1280×900 and English at 900×900: open status/details, close, Escape,
  and refresh never complete a shared step; life controls fit the viewport.
- Pause/resume, three rapid real pointer clicks, a deliberately lost committed
  response, exact-envelope/receipt retry, and withdrawal while paused.
- Real chat focus/draft and read-only synthetic execution/approval recovery enter
  the production controller. Life status/invitations and open details disappear;
  clearing blockers does not reopen the details or replay the bid.
- Hidden status remains reachable through Settings; an open detail changes from
  Chinese to English; proactivity off preserves interests; disabling life leaves
  the synthetic job board and add/cancel dialog usable.
- Two pages share fixture state. A stale second-page settings command receives
  409 and refreshes the current snapshot instead of overwriting it.

The fixture validates UUID command envelopes, revision/identity/activity binding,
exact receipt replay and the transitions being asserted. Only scenario-armed
control writes plus bounded lifecycle/presence/bid calls are accepted. Unknown
API requests, model/job writes, credential headers, external origins, WebSockets,
unsafe/missing assets and CSP violations fail the gate. The localization fixture
is reused only for unrelated, explicitly supported GETs.

## Evidence and limits

`report.txt` and `report.json` contain scenario outcomes, assertions, commit/tree,
lock/build-index hashes, command identities, receipts, request counts, page
errors, console output and network violations. `requests.json`, screenshots,
DOM HTML and accessibility text are retained on assertion failures as well as
success. A browser/setup failure still writes reports, but cannot produce a
screenshot. The workflow uploads whatever evidence exists even on failure.

The fixture deliberately models only the required UI transitions. Its passing
Node guard tests are not a browser pass; its passing Chromium run is not a
backend correctness or real-model evaluation. No production source, existing
localization test, dependency or release workflow is changed by this gate.
