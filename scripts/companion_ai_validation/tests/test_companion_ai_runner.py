"""Admission, environment isolation, and full fake broker/product integration."""
import json
from pathlib import Path

import pytest

from scripts.companion_ai_validation import broker as gate
from scripts.companion_ai_validation import run


@pytest.fixture
def admission():
    now = gate.PRICE_VALID_UNTIL - 3600
    record = {"schema": 1, "source_sha": "b" * 40, "helper_sha": "a" * 40,
              "run_id": "123", "checked_at": int(now)}
    metadata = {"GITHUB_SHA": "b" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": "offercontext/offerPilot",
                "GITHUB_REF": "refs/heads/feat/20261021-companion-life-v1"}
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
    assert profile["max_output_tokens"] == 512
    assert profile["supports_json_schema"] is False
    assert (tmp_path / "config.json").stat().st_mode & 0o777 == 0o600


def test_run_matrix_has_exact_one_completion_per_stage(tmp_path, monkeypatch):
    import scripts.companion_ai_validation.driver as driver
    import urllib.request
    from scripts.companion_ai_validation.tests.test_companion_ai_broker import payload, response

    monkeypatch.setattr(gate.time, "time", lambda: gate.PRICE_VALID_UNTIL - 3600)
    calls = []

    def fake(raw):
        calls.append(gate.decode(raw))
        return 200, gate.encode(response())

    def matrix(data_dir, stage, *, record_response):
        for operation in gate.OPERATIONS:
            with stage(operation):
                config = json.loads((data_dir / "config.json").read_bytes())["providers"][0]
                request = urllib.request.Request(
                    config["base_url"] + "/chat/completions", gate.encode(payload(operation)),
                    {"Authorization": "Bearer " + config["api_key"],
                     "Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=5) as result:
                    assert result.status == 200
        return {"passed": True, "responses": ["Synthetic response"]}

    monkeypatch.setattr(driver, "run_matrix", matrix)
    report = run.execute(fake, "b" * 40, tmp_path / "evidence")
    assert report["matrix"]["passed"], report
    assert len(calls) == 12
    assert report["budget"]["request_count"] == 12
    assert report["budget"]["settled_micro_cny"] == 12 * 360
    assert report["budget"]["reserved_micro_cny"] == 0
    assert report["budget"]["stages_complete"] == 12
    assert {p.name for p in (tmp_path / "evidence").iterdir()} == {"summary.json", "budget.jsonl", "responses.jsonl"}
    text = (tmp_path / "evidence" / "budget.jsonl").read_text()
    assert "messages" not in text and "api_key" not in text
    assert "Synthetic response" in (tmp_path / "evidence" / "summary.json").read_text()


def test_workflow_has_one_secret_step_and_no_pr_or_write_path():
    path = Path(__file__).resolve().parents[3] / ".github/workflows/companion-real-ai.yml"
    workflow = path.read_text()
    assert workflow.count("${{ secrets.OFFERPILOT_COMPANION_DEEPSEEK_20261021 }}") == 1
    assert "  workflow_dispatch:" not in workflow
    assert "  pull_request:" not in workflow
    assert "  pull_request_target:" not in workflow
    assert ": write" not in workflow
    assert "cancel-in-progress: false" in workflow
    assert "environment: offerpilot-companion-ai-20261021" in workflow
    assert workflow.count("github.sha == vars.OFFERPILOT_COMPANION_AI_REQUEST_SHA") == 2
    assert "persist-credentials: true" not in workflow
    for phase in ("inspect", "before", "paid"):
        assert f"python -m scripts.companion_ai_validation.preflight --phase {phase}" in workflow
    assert "artifacts/companion-ai/summary.json" in workflow
    assert "artifacts/companion-ai/budget.jsonl" in workflow


def test_main_never_inherits_provider_secret_into_git_or_driver(tmp_path, monkeypatch, admission):
    import subprocess
    import sys
    record, metadata, now = admission
    path = tmp_path / "admission.json"
    path.write_text(json.dumps(record))
    environment = {**metadata, run.KEY_NAME: "synthetic-secret-do-not-inherit",
                   run.MODEL_NAME: gate.MODEL,
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
        return {"matrix": {"passed": True}, "budget": {}}

    monkeypatch.setattr(run.subprocess, "run", git)
    monkeypatch.setattr(run, "HTTPSUpstream", Transport)
    monkeypatch.setattr(run, "execute", execute)
    assert run.main() == 0
    assert len(commands) == 2


def synthetic_entry(operation):
    return {'operation': operation, 'user_input': 'Synthetic user',
            'assistant_text': 'Synthetic successful reply', 'expected_context': None,
            'source_facts_before_projection': None, 'snapshot': {}, 'provenance': {},
            'ordinary_turn_read_only': True, 'source_verified': True}


def test_successful_samples_persist_without_replacing_or_exposing_config(tmp_path):
    path = tmp_path / 'responses.jsonl'
    evidence = run.ResponseEvidence(path)
    evidence.record(synthetic_entry(gate.OPERATIONS[0]))
    assert json.loads(path.read_text()) == synthetic_entry(gate.OPERATIONS[0])
    with pytest.raises(gate.GateError, match='synthetic_evidence_shape'):
        evidence.record(synthetic_entry(gate.OPERATIONS[0]))
    evidence.close()
    with pytest.raises(FileExistsError):
        run.ResponseEvidence(path)
    assert len(path.read_text().splitlines()) == 1


@pytest.mark.parametrize('change', [
    lambda e: e.update(api_key='must-not-log'),
    lambda e: e.update(source_verified=False),
    lambda e: e.update(assistant_text='x' * 8193),
    lambda e: e.update(provenance={'too_large': 'x' * 40000}),
])
def test_unsafe_or_unbounded_sample_is_never_written(tmp_path, change):
    path = tmp_path / 'responses.jsonl'
    evidence = run.ResponseEvidence(path)
    entry = synthetic_entry(gate.OPERATIONS[0])
    change(entry)
    with pytest.raises(gate.GateError):
        evidence.record(entry)
    evidence.close()
    assert path.read_bytes() == b''


@pytest.mark.parametrize('damage', ['skip', 'missing', 'duplicate', 'deselected', 'failed'])
def test_mandatory_linux_aggregate_rejects_incomplete_nodes(damage):
    from types import SimpleNamespace
    from scripts.companion_ai_validation.test_gate import CompletionLedger
    ledger = CompletionLedger()
    ledger.collected = ['test_one']
    for phase in ['setup', 'call', 'teardown']:
        ledger.pytest_runtest_logreport(SimpleNamespace(nodeid='test_one', when=phase, outcome='passed'))
    assert ledger.report(0)['passed']
    if damage == 'skip':
        ledger.finished['test_one']['call'] = 'skipped'
    elif damage == 'missing':
        ledger.finished.clear()
    elif damage == 'duplicate':
        ledger.pytest_runtest_logreport(SimpleNamespace(nodeid='test_one', when='call', outcome='passed'))
    elif damage == 'deselected':
        ledger.pytest_deselected([SimpleNamespace(nodeid='test_two')])
    else:
        ledger.finished['test_one']['teardown'] = 'failed'
    assert not ledger.report(0)['passed']


def test_actual_product_chat_matrix_through_strict_budget_and_sse_boundary(tmp_path, monkeypatch):
    from scripts.companion_ai_validation.tests.test_companion_ai_broker import response
    monkeypatch.setattr(gate.time, 'time', lambda: gate.PRICE_VALID_UNTIL - 3600)
    calls = []

    def fake(raw):
        body = gate.decode(raw)
        assert body['model'] == gate.MODEL and body['max_tokens'] == 512
        assert body['thinking'] == {'type': 'disabled'} and body['stream'] is False
        calls.append(body)
        return 200, gate.encode(response(content='合成验收回复，仅用于验证真实 API 与账本边界。'))

    report = run.execute(fake, 'b' * 40, tmp_path / 'evidence')
    assert report['matrix']['passed'], report
    assert report['matrix']['pass_scope'] == 'mechanism_only'
    assert report['matrix']['tone_review_required'] is True
    assert len(calls) == 12
    assert report['budget']['request_count'] == 12
    assert report['budget']['settled_micro_cny'] == 12 * 360
    assert report['budget']['reserved_micro_cny'] == 0
    entries = [json.loads(line) for line in (tmp_path / 'evidence/responses.jsonl').read_text().splitlines()]
    assert [entry['operation'] for entry in entries] == list(gate.OPERATIONS)
    assert all(entry['source_verified'] for entry in entries)
    assert all(call['tools'] and call['tool_choice'] == 'auto' for call in calls)
