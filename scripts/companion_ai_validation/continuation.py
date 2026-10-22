"""One fixed corrective batch, linked to immutable synthetic predecessor evidence.

Standard library only. No network, credential, caller-selected balance, URL or
predecessor. Every public verification re-reads the fixed, hash-pinned archive.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import stat
from typing import Any
import zipfile

ADMISSION_SCHEMA = 2
CAMPAIGN_ID = "one-shot-20261021"
CORRECTION_ORDINAL = 1
PREDECESSOR_RUN_ID = 39736858377
PREDECESSOR_HELPER_RUN_ID = 39699222167
PREDECESSOR_ARTIFACT_ID = 12408325852
PREDECESSOR_SOURCE_SHA = "6329657d841b1bc4d8e3a3cdb7618df92c5a140a"
PREDECESSOR_HELPER_SHA = "3f139ada435b2398e52b65162208a8cbb818b8ef"
PREDECESSOR_TREE_SHA = "5ba642bbdd2a8d714764a43a448752cd92b2b689"
ARCHIVE_SHA256 = "86bbef7eee6db958f70f59695f99e15179c458a4f0def363b1742b7bfb246cf7"
LEDGER_SHA256 = "8cc6ff556286f3b158925d007e5c44f24c58a04d8a85702911cd39a83e405074"
ARCHIVE_SIZE = 17499
MEMBERS = {
    "budget.jsonl": (10791, LEDGER_SHA256),
    "summary.json": (51043, "3efaaff13bb040c4337acf7a4dac4b80025062c6ecf50aaf3669b206810c6995"),
    "responses.jsonl": (41048, "2c8b58af851fde4eac35503e52d65960039d2a15d21e081cc9f1346c9ea10d93"),
}
EVIDENCE_PATH = Path(__file__).with_name("evidence") / "predecessor-39736858377.zip"
BUDGET = 20_000_000
RESERVATION = 3_000_000
PRIOR_SETTLED = 103_154
PRIOR_REQUESTS = 12
PRICE_VALID_UNTIL = int(datetime(2026, 10, 24, tzinfo=timezone.utc).timestamp())
OPERATIONS = (
    "independent_play", "shared_wait_after_absence", "actual_color_choice",
    "unpressured_leisure", "paused_gap", "serious_mixed_work",
    "work_finish_continuation", "boat_specific_memory", "cloud_specific_memory",
    "same_type_ambiguity", "deleted_source_memory", "withdrawal_and_boundaries",
)
OPERATIONS_SHA256 = hashlib.sha256(json.dumps(
    OPERATIONS, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
).encode()).hexdigest()
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_STATE_KEYS = frozenset(("schema", "source_sha", "request_count", "settled_micro_cny",
                         "reserved_micro_cny", "budget_micro_cny", "halted"))
LINEAGE_KEYS = frozenset((
    "campaign_id", "correction_ordinal", "predecessor_run_id", "predecessor_artifact_id",
    "predecessor_source_sha", "predecessor_helper_sha", "predecessor_archive_sha256",
    "predecessor_ledger_sha256", "prior_settled_micro_cny", "prior_reserved_micro_cny",
    "prior_request_count", "budget_micro_cny", "operations_sha256", "price_valid_until",
))


class ContinuationError(RuntimeError):
    """Only fixed safe error codes, never artifact contents or filesystem paths."""


def _demand(condition: bool, code: str = "PREDECESSOR_EVIDENCE_INVALID") -> None:
    if not condition:
        raise ContinuationError(code)


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _demand(key not in result)
        result[key] = value
    return result


def _constant(_: str) -> None:
    raise ContinuationError("PREDECESSOR_EVIDENCE_INVALID")


def _json(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ContinuationError("PREDECESSOR_EVIDENCE_INVALID") from None
    _demand(isinstance(value, dict))
    assert isinstance(value, dict)
    return value


def _lines(raw: bytes) -> list[dict[str, Any]]:
    _demand(bool(raw) and raw.endswith(b"\n") and b"\r" not in raw)
    lines = raw.splitlines()
    _demand(bool(lines) and len(lines) <= 38 and all(0 < len(line) <= 32768 for line in lines))
    return [_json(line) for line in lines]


def _exact(value: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
    return all(key in value and type(value[key]) is type(item) and value[key] == item
               for key, item in expected.items())


def _state(count: int, settled: int, reserved: int, *, closed: bool = False) -> dict[str, Any]:
    return {"schema": 1, "source_sha": PREDECESSOR_SOURCE_SHA, "request_count": count,
            "settled_micro_cny": settled, "reserved_micro_cny": reserved,
            "budget_micro_cny": BUDGET, "halted": closed}


def _replay_ledger(raw: bytes) -> dict[str, Any]:
    """Replay a fixed complete predecessor; no unknowns can become free money."""
    rows = _lines(raw)
    _demand(len(rows) == 2 + 3 * PRIOR_REQUESTS)
    _demand(set(rows[0]) == _STATE_KEYS | {"event"}
            and _exact(rows[0], {**_state(0, 0, 0), "event": "created"}))
    settled = 0
    for index, operation in enumerate(OPERATIONS):
        reserve, settlement, complete = rows[1 + index * 3:4 + index * 3]
        _demand(set(reserve) == _STATE_KEYS | {"event", "operation", "body_sha256"}
                and _exact(reserve, {**_state(index + 1, settled, RESERVATION),
                                    "event": "reserved", "operation": operation})
                and isinstance(reserve["body_sha256"], str)
                and bool(_HASH.fullmatch(reserve["body_sha256"]))
                and settled + RESERVATION <= BUDGET)
        _demand(set(settlement) == _STATE_KEYS | {
            "event", "operation", "cost_micro_cny", "prompt_tokens", "completion_tokens"})
        prompt, completion, cost = (settlement.get(key) for key in
                                    ("prompt_tokens", "completion_tokens", "cost_micro_cny"))
        _demand(type(prompt) is int and 0 <= prompt <= 1_048_576
                and type(completion) is int and 0 <= completion <= 512
                and prompt + completion <= 1_048_576
                and type(cost) is int and cost == prompt * 2 + completion * 8
                and 0 <= cost <= RESERVATION)
        assert isinstance(cost, int)
        settled += cost
        _demand(_exact(settlement, {**_state(index + 1, settled, 0),
                                    "event": "settled", "operation": operation}))
        _demand(set(complete) == _STATE_KEYS | {"event", "operation", "calls"}
                and _exact(complete, {**_state(index + 1, settled, 0),
                                      "event": "stage_complete", "operation": operation, "calls": 1}))
    _demand(settled == PRIOR_SETTLED)
    # Broker.close intentionally marks closed.halted=true; a halted event or an
    # unclosed/uncertain reservation is never accepted by the exact replay above.
    _demand(set(rows[-1]) == _STATE_KEYS | {"event"}
            and _exact(rows[-1], {**_state(PRIOR_REQUESTS, settled, 0, closed=True), "event": "closed"}))
    return _state(PRIOR_REQUESTS, settled, 0)


def _verify_archive(raw: bytes) -> None:
    _demand(len(raw) == ARCHIVE_SIZE and hashlib.sha256(raw).hexdigest() == ARCHIVE_SHA256,
            "PREDECESSOR_ARCHIVE_MISMATCH")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            _demand(len(infos) == len(MEMBERS) and {i.filename for i in infos} == set(MEMBERS))
            members: dict[str, bytes] = {}
            for info in infos:
                size, digest = MEMBERS[info.filename]
                mode = info.external_attr >> 16
                _demand(not info.is_dir() and stat.S_ISREG(mode)
                        and not info.flag_bits & 1 and info.compress_type == zipfile.ZIP_DEFLATED
                        and info.file_size == size and 0 < info.compress_size <= ARCHIVE_SIZE)
                with archive.open(info) as stream:
                    data = stream.read(size + 1)
                _demand(len(data) == size and hashlib.sha256(data).hexdigest() == digest,
                        "PREDECESSOR_MEMBER_MISMATCH")
                members[info.filename] = data
    except (OSError, ValueError, EOFError, RuntimeError, zipfile.BadZipFile) as exc:
        if isinstance(exc, ContinuationError):
            raise
        raise ContinuationError("PREDECESSOR_EVIDENCE_INVALID") from None
    state = _replay_ledger(members["budget.jsonl"])
    summary, responses = _json(members["summary.json"]), _lines(members["responses.jsonl"])
    _demand(set(summary) == {"schema", "matrix", "budget"}
            and type(summary["schema"]) is int and summary["schema"] == 1)
    budget, matrix = summary["budget"], summary["matrix"]
    _demand(isinstance(budget, dict) and set(budget) == _STATE_KEYS | {"stages_complete"}
            and _exact(budget, {**state, "stages_complete": PRIOR_REQUESTS})
            and isinstance(matrix, dict)
            and _exact(matrix, {"passed": True, "pass_scope": "mechanism_only", "schema_version": 1,
                                "synthetic_only": True, "ordinary_count": PRIOR_REQUESTS,
                                "tone_review_required": True, "transport": "uvicorn:/api/chat"})
            and len(responses) == PRIOR_REQUESTS and matrix.get("responses") == responses)
    for operation, response in zip(OPERATIONS, responses, strict=True):
        _demand(_exact(response, {"operation": operation, "ordinary_turn_read_only": True,
                                  "source_verified": True})
                and isinstance(response.get("assistant_text"), str)
                and 0 < len(response["assistant_text"].encode()) <= 8192)


@dataclass(frozen=True)
class Predecessor:
    settled_micro_cny: int = PRIOR_SETTLED
    reserved_micro_cny: int = 0
    request_count: int = PRIOR_REQUESTS
    source_sha: str = PREDECESSOR_SOURCE_SHA
    helper_sha: str = PREDECESSOR_HELPER_SHA
    run_id: int = PREDECESSOR_RUN_ID
    artifact_id: int = PREDECESSOR_ARTIFACT_ID
    archive_sha256: str = ARCHIVE_SHA256
    ledger_sha256: str = LEDGER_SHA256


def verified_predecessor() -> Predecessor:
    """No caller path/balance; unavailable, altered or uncertain evidence blocks."""
    try:
        _demand(EVIDENCE_PATH.is_file() and not EVIDENCE_PATH.is_symlink(),
                "PREDECESSOR_EVIDENCE_UNAVAILABLE")
        with EVIDENCE_PATH.open("rb") as stream:
            raw = stream.read(ARCHIVE_SIZE + 1)
    except OSError:
        raise ContinuationError("PREDECESSOR_EVIDENCE_UNAVAILABLE") from None
    _verify_archive(raw)
    return Predecessor()


def lineage_fields() -> dict[str, Any]:
    previous = verified_predecessor()
    return {
        "campaign_id": CAMPAIGN_ID, "correction_ordinal": CORRECTION_ORDINAL,
        "predecessor_run_id": previous.run_id, "predecessor_artifact_id": previous.artifact_id,
        "predecessor_source_sha": previous.source_sha, "predecessor_helper_sha": previous.helper_sha,
        "predecessor_archive_sha256": previous.archive_sha256,
        "predecessor_ledger_sha256": previous.ledger_sha256,
        "prior_settled_micro_cny": previous.settled_micro_cny,
        "prior_reserved_micro_cny": previous.reserved_micro_cny,
        "prior_request_count": previous.request_count, "budget_micro_cny": BUDGET,
        "operations_sha256": OPERATIONS_SHA256, "price_valid_until": PRICE_VALID_UNTIL,
    }


def validate_lineage(record: Mapping[str, Any]) -> None:
    """Validate lineage within an admission/journal, not arbitrary starting money."""
    _demand(isinstance(record, Mapping) and _exact(record, lineage_fields()), "CONTINUATION_LINEAGE_MISMATCH")
