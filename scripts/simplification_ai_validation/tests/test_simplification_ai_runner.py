"""Admission, environment isolation, and full fake broker/product integration."""
import json
from pathlib import Path

import pytest

from scripts.simplification_ai_validation import broker as gate
from scripts.simplification_ai_validation import run
from scripts.simplification_ai_validation.tests.test_simplification_ai_driver import (
    fake_completion,
)


@pytest.fixture
def admission():
    now = gate.PRICE_VALID_UNTIL - 3600
    record = {"schema": 1, "source_sha": "b" * 40, "helper_sha": "a" * 40,
              "run_id": "123", "checked_at": int(now)}
    metadata = {"GITHUB_SHA": "b" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": "offercontext/offerPilot",
                "GITHUB_REF": "refs/heads/feat/20261021-product-simplification"}
    return record, metadata, now


def test_admission_is_exact_current_run_and_fresh(admission):
    record, metadata, now = admission
    assert run.check_admission(record, metadata, now) == "b" * 40


@pytest.mark.parametrize("key,value", [
    ("GITHUB_SHA", "c" * 40), ("GITHUB_RUN_ID", "124"), ("GITHUB_RUN_ATTEMPT", "2"),
    ("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REPOSITORY", "someone/fork"),
    ("GITHUB_REF", "refs/pull/123/merge"),
])
def test_bad_run_identity_never_admits(admission, key, value):
    record, metadata, now = admission
    metadata[key] = value
    with pytest.raises(gate.GateError, match="admission_identity"):
        run.check_admission(record, metadata, now)


@pytest.mark.parametrize("age", [-1, 121])
def test_stale_or_future_admission_is_not_reusable(admission, age):
    record, metadata, now = admission
    with pytest.raises(gate.GateError, match="admission_expired"):
        run.check_admission(record, metadata, now + age)


def test_admission_cannot_extend_reviewed_price_window(admission):
    record, metadata, _ = admission
    record["checked_at"] = int(gate.PRICE_VALID_UNTIL - 89)
    with pytest.raises(gate.GateError, match="price_review_expired"):
        run.check_admission(record, metadata, record["checked_at"])


def test_clean_environment_drops_every_inherited_key(monkeypatch):
    fake = {"SSLKEYLOGFILE": "private", "SSL_CERT_FILE": "private", "SSL_CERT_DIR": "private",
            "HTTPS_PROXY": "private", run.KEY_NAME: "private", "GH_TOKEN": "private",
            "UNEXPECTED_CREDENTIAL": "private"}
    monkeypatch.setattr(run.os, "environ", fake)
    run.clean_environment()
    assert "private" not in json.dumps(fake)
    assert set(fake) == {"PATH", "LANG", "LITELLM_LOCAL_MODEL_COST_MAP", "PYTHONNOUSERSITE",
                         "PYTHONDONTWRITEBYTECODE", "DO_NOT_TRACK"}


def test_temporary_config_contains_only_loopback_credential_and_no_fallback(tmp_path):
    run.write_config(tmp_path, "http://127.0.0.1:12345/v1", "synthetic-loopback-only")
    config = json.loads((tmp_path / "config.json").read_bytes())
    assert config["fallback_provider_ids"] == []
    assert config["chat_auto_approve_writes"] is False
    profile, = config["providers"]
    assert profile["api_key"] == "synthetic-loopback-only"
    assert profile["max_output_tokens"] == 4096
    assert profile["supports_json_schema"] is False
    assert (tmp_path / "config.json").stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize("format_repairs", [False, True])
def test_genuine_cli_and_http_matrix_through_actual_budget_broker(tmp_path, monkeypatch,
                                                               format_repairs):
    # Do not make the offline integration depend on the live price quote's date.
    monkeypatch.setattr(gate.time, "time", lambda: gate.PRICE_VALID_UNTIL - 3600)
    calls = []
    completed = 0

    def fake(raw):
        nonlocal completed
        operation = gate.OPERATIONS[completed]
        body = gate.decode(raw)
        calls.append(operation)
        reply = fake_completion(body, operation)
        if (format_repairs and operation.startswith(("quick_", "event_"))
                and calls.count(operation) == 1):
            reply["choices"][0]["message"]["content"] = "not JSON"
        else:
            completed += 1
        return 200, gate.encode(reply)

    report = run.execute(fake, "b" * 40, tmp_path / "evidence")
    assert report["matrix"]["passed"], report
    expected = [operation for operation in gate.OPERATIONS
                for _ in range(2 if format_repairs and
                               operation.startswith(("quick_", "event_")) else 1)]
    assert calls == expected
    assert report["budget"]["request_count"] == len(expected)
    assert report["budget"]["settled_micro_cny"] == len(expected) * 1000
    assert report["budget"]["reserved_micro_cny"] == 0
    assert report["budget"]["stages_complete"] == 12
    assert {p.name for p in (tmp_path / "evidence").iterdir()} == {"summary.json", "budget.jsonl"}
    text = (tmp_path / "evidence" / "budget.jsonl").read_text()
    assert "messages" not in text and "evidence_catalog" not in text and "api_key" not in text
    assert sum(json.loads(line)["event"] == "reserved" for line in text.splitlines()) == len(expected)


def test_workflow_has_one_secret_step_and_no_pr_or_write_path():
    path = Path(__file__).resolve().parents[3] / ".github/workflows/simplification-real-ai.yml"
    workflow = path.read_text()
    assert workflow.count("${{ secrets.OFFERPILOT_SIMPLIFICATION_DEEPSEEK_20261021 }}") == 1
    assert "  workflow_dispatch:" not in workflow
    assert "  pull_request:" not in workflow
    assert "  pull_request_target:" not in workflow
    assert ": write" not in workflow
    assert "cancel-in-progress: false" in workflow
    assert "environment: offerpilot-simplification-ai-20261021" in workflow
    assert workflow.count("github.sha == vars.OFFERPILOT_SIMPLIFICATION_AI_REQUEST_SHA") == 2
    assert "persist-credentials: true" not in workflow
    assert 'preflight.py --phase paid' in workflow
    assert "artifacts/simplification-ai/summary.json" in workflow
    assert "artifacts/simplification-ai/budget.jsonl" in workflow


def test_main_never_inherits_provider_secret_into_git_or_driver(tmp_path, monkeypatch, admission):
    import subprocess
    import sys
    record, metadata, now = admission
    path = tmp_path / "admission.json"
    path.write_text(json.dumps(record))
    environment = {**metadata, run.KEY_NAME: "synthetic-secret-do-not-inherit",
                   run.BASE_NAME: gate.BASE_URL, run.MODEL_NAME: gate.MODEL,
                   "SSLKEYLOGFILE": "synthetic-untrusted-file", "GH_TOKEN": "synthetic-gh-token"}
    monkeypatch.setattr(run.os, "environ", environment)
    monkeypatch.setattr(run.time, "time", lambda: now)
    monkeypatch.setattr(sys, "argv", ["run", "--live", "--admission-file", str(path),
                                     "--evidence-dir", str(tmp_path / "evidence")])
    commands = []

    def git(command, **kwargs):
        commands.append(command)
        assert set(kwargs["env"]) == {"PATH", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"}
        assert "synthetic" not in json.dumps(kwargs["env"])
        return subprocess.CompletedProcess(command, 0,
                                           record["source_sha"].encode() if len(commands) == 1 else b"")

    class Transport:
        def __init__(self, key):
            assert key == "synthetic-secret-do-not-inherit"
            assert "synthetic" not in json.dumps(environment)

    def execute(transport, sha, evidence):
        assert isinstance(transport, Transport)
        assert sha == record["source_sha"]
        assert "synthetic" not in json.dumps(environment)
        return {"matrix": {"passed": True}}

    monkeypatch.setattr(run.subprocess, "run", git)
    monkeypatch.setattr(run, "HTTPSUpstream", Transport)
    monkeypatch.setattr(run, "execute", execute)
    assert run.main() == 0
    assert len(commands) == 2
