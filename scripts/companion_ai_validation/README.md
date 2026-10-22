# Companion one-shot experience validation

This is a Linux-only acceptance harness, not an installed product feature or a
second agent. It uses a fresh owned database, the real loopback `/api/chat`
endpoint, twelve fixed synthetic ordinary turns and real bounded companion
commands. No existing user configuration, account or record is loaded.

## Evidence boundary

The driver simulates a week with a child-only companion clock. It checks real
waiting, choice provenance, pause/gap behavior, mixed work priority, boat/cloud
recall, ambiguity, source deletion, withdrawal, quiet/off guards and unchanged
business records. Deterministic command receipts are not provider tone samples.

`passed` with `pass_scope=mechanism_only` does not mean the persona passed. Human
review must inspect the twelve successful ordinary replies for natural brevity,
playfulness without forced maturity or care debt, accurate work uncertainty,
source-grounded continuity and no invented external action. Any fabricated
shared/tool fact, restored deleted memory, guilt or work-approval bypass is a
hard failure. Each remaining applicable dimension is scored 0–2; require no
zero for provenance/work/non-pressure and mean at least 1.5. No template growth
or new product settings substitute for this review.

Only the actual projected `expected_context` was visible to the model.
`source_facts_before_projection` may contain optional real fixture facts omitted
by the production 2 KiB context cap; do not grade a model as having seen them.
Successful bounded samples are fsynced incrementally to `responses.jsonl`, so a
later failure does not discard earlier paid evidence. Summary and ledger contain
fixed errors, never provider error bodies or credentials. All retained dialogue
and state are synthetic. Production request messages and 26 tool schemas remain
intact; no tools are executed by this harness.

## Fixed paid boundary

- Independent environment: `offerpilot-companion-ai-20261021`.
- Dedicated environment secret: `OFFERPILOT_COMPANION_DEEPSEEK_20261021`.
- Environment variable: `OFFERPILOT_COMPANION_AI_MODEL=deepseek-flash`.
- Fixed official TLS host `api.deepseek.com`, path `/chat/completions`.
- Separate task-total cap: RMB20, including failed and unknown attempts.
- Initial batch: exactly twelve ordered slots, at most one actual HTTP request per
  slot, no retries, SDK retries, format repair, fallback or automatic extra batch.
- Explicit thinking disabled and 512 output-token cap. The production client uses
  streaming; the broker makes one non-streaming upstream request and exposes local
  SSE only after complete model/content/usage/tool validation and durable settlement.
  A tool-bearing response is rejected before any text reaches product execution.
- Integer micro-CNY accounting: peak cache-miss input RMB2/million, output
  RMB8/million, reverified on 2026-10-22 against the [official price page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/).
  [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) defaults on,
  so disabling it is explicit. The reviewed quote expires at 2026-10-24 00:00 UTC;
  code must not silently extend it. This is the same activity and cumulative
  RMB20 budget, not another allocation. The expired request remains unpushed.
- Before each actual HTTP request, fsync a RMB3 reservation. The documented
  1,048,576-token context and 512 output cap cost less than this even at peak rates.
  Trusted, consistent usage alone releases the difference. Unknown status, usage,
  timeout, concurrent/duplicate requests or tampered journal retain liability and
  halt. Wall/monotonic session and price windows are checked after fsync and TLS
  connection, immediately before sending HTTP. No proxy, redirect or custom TLS.
- Journals cannot reopen/reset. A rerun, missing history, previous non-skipped paid
  job or recreated pinned workflow/environment/policy blocks. A later correction
  batch needs an explicitly reviewed cumulative-budget continuation, not a new
  workflow identity or a fresh RMB20 budget.

The earlier 48k input-token figure was a planning estimate, not the budget gate.
Actual production schemas/history are not silently trimmed to meet that guess.
Fake-run request byte sizes are measurable; actual tokens are established only
by the provider's validated usage. The conservative monetary reservation is the
hard bound before every send.

## Safe publication and approval

The initial unarmed publication used zero binding IDs. Its successful registration
run [39632913549](https://github.com/offercontext/offerPilot/actions/runs/39632913549)
verified workflow `391917473`, environment `24931188785` and branch policy
`63853345`; this helper pins those identities. The offline job reads only public
protection metadata and its own workflow registration, emitting bounded IDs. It
never reads secret management endpoints. Failure to read/verify metadata blocks,
not implies absent. Pinning alone does not authorize or trigger a paid request.

The independently reviewed helper H must pass its complete offline workflow.
A request R must be H's single-parent, same-tree empty
child, with the exact marker from `preflight.marker(H)`. Repository variables
`OFFERPILOT_COMPANION_AI_HELPER_SHA` and
`OFFERPILOT_COMPANION_AI_REQUEST_SHA` must bind H/R before R is pushed.

Only `feat/20261021-companion-life-v1` is allowed. The dedicated environment must
require `XiaoZheBrother`, disallow admin bypass, and allow that owner to review
own pushes. Before and after environment approval, preflight verifies current
SHA, event, full run/job history and exact owner approval. Secret-free
preflight also requires a full twenty-minute session remaining in the reviewed
quote. The same wall/monotonic window spans event and metadata reads, admission
open/flush/fsync and final success. Expired or too-late requests fail without
authorizing the provider-secret step, even if an admission write stalled.
Registration-only
inspection remains available after expiry; it cannot authorize any request.
Read-only Actions
metadata tokens are never passed to the product. The provider key appears in one
paid step only, then remains solely inside the fixed upstream transport; the
child process receives an allowlisted clean environment and a short-lived
loopback capability. Installing dependencies and offline tests have no provider
secret. No PR, release, dispatch, browser/login, external account or tool action.

## Offline tests

Run on Linux, with the repository's normal loopback-only pytest guard:

```sh
uv run python -m scripts.companion_ai_validation.test_gate
uv run pytest -q tests/test_companion_ai_platform_contract.py
uv run ruff check scripts/companion_ai_validation tests/test_companion_ai_platform_contract.py
uv run mypy scripts/companion_ai_validation/*.py --follow-imports=silent --explicit-package-bases
```

The Linux gate requires every collected node to finish setup/call/teardown and
pass, with no skips, deselection, duplication or missing nodes; it writes
`artifacts/companion-ai-offline.json`. Linux durability/real-process tests live
outside the default production `tests/` collection. Default Windows/macOS tests
retain an explicit early platform-rejection contract; durability is never a
no-op or silently skipped safety check. Live entrypoints reject unsupported
platforms before reading admission/key, creating evidence or sending network.
