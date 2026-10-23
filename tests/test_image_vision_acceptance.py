from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from scripts import image_vision_acceptance as acceptance


def _payload(key: str = "test-only") -> dict[str, Any]:
    return {
        "api_base": acceptance.BASE_URL, "api_key": key,
        "model": "openai/deepseek-flash", "stream": True,
        "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {
            "url": "data:image/png;base64," + base64.b64encode(b"fixture").decode(),
        }}]}], "tools": [{"type": "function"}],
    }


@pytest.mark.parametrize("endpoint", [
    "http://api.deepseek.com", "https://evil.test", "https://api.deepseek.com.evil.test",
    "https://api.deepseek.com@evil.test", "https://user@api.deepseek.com",
    "https://api.deepseek.com:443", "https://api.deepseek.com/v2",
    "https://api.deepseek.com?token=x", "https://api.deepseek.com/#x",
])
def test_endpoint_rejects_unapproved_destinations(endpoint: str) -> None:
    with pytest.raises(acceptance.AcceptanceError, match="endpoint_not_allowed"):
        acceptance.validate_endpoint(endpoint)


@pytest.mark.parametrize("endpoint", [acceptance.BASE_URL, acceptance.BASE_URL + "/v1"])
def test_official_endpoint_allowed(endpoint: str) -> None:
    assert acceptance.validate_endpoint(endpoint) == endpoint


@pytest.mark.parametrize("case", acceptance.CASES)
def test_all_four_scorers_require_exact_fields(case: str) -> None:
    expected = acceptance.EXPECTED[case]
    assert acceptance.grade(case, json.dumps(expected, ensure_ascii=False))["passed"]
    assert acceptance.grade(case, "```json\n" + json.dumps(expected) + "\n```")["passed"]
    missing = dict(expected)
    missing.pop(next(iter(expected)))
    assert not acceptance.grade(case, json.dumps(missing))["passed"]
    assert not acceptance.grade(case, "无法看图")["passed"]


def test_scorers_reject_negation_loss_hallucination_and_boolean_count() -> None:
    chinese = dict(acceptance.EXPECTED["chinese"], instruction="请携带纸质简历")
    assert not acceptance.grade("chinese", json.dumps(chinese))["passed"]
    job = dict(acceptance.EXPECTED["job"], contact="recruiter@example.test")
    assert not acceptance.grade("job", json.dumps(job))["passed"]
    geometry = dict(acceptance.EXPECTED["geometry"], green_triangles=True)
    assert not acceptance.grade("geometry", json.dumps(geometry))["passed"]


def test_guard_hard_limit_no_retry_and_safe_failure() -> None:
    attempts = []

    async def invoke(**kwargs: Any) -> Any:
        attempts.append(kwargs)

        async def stream() -> Any:
            yield {"choices": [{"delta": {"content": "{}"}}],
                   "usage": {"prompt_tokens": 100, "completion_tokens": 2, "secret": "no"}}
        return stream()

    guard = acceptance.GuardedTransport("test-only", invoke)
    guard.expected_hash = hashlib.sha256(b"fixture").hexdigest()

    async def run() -> None:
        for case in acceptance.CASES:
            guard.case = case
            stream = await guard(**_payload())
            async for _ in stream:
                pass
        with pytest.raises(acceptance.AcceptanceError, match="provider_call_limit"):
            await guard(**_payload())
    asyncio.run(run())
    assert len(attempts) == 4
    assert all(call["num_retries"] == 0 and call["max_retries"] == 0 for call in attempts)
    assert all(call["max_tokens"] == 512 and call["timeout"] == 45 for call in attempts)
    assert all(call["extra_body"] == {"thinking": {"type": "disabled"}} for call in attempts)
    assert all(call["tool_choice"] == "none" for call in attempts)
    assert guard.records[0]["usage"] == {"prompt_tokens": 100, "completion_tokens": 2}
    assert "test-only" not in json.dumps(guard.records)


def test_guard_counts_failed_attempt_once_and_blocks_duplicate() -> None:
    attempts = []

    async def failing(**kwargs: Any) -> Any:
        attempts.append(1)
        raise RuntimeError("secret test-only data:image/png;base64,PRIVATE")

    guard = acceptance.GuardedTransport("test-only", failing)
    guard.case = "geometry"
    guard.expected_hash = hashlib.sha256(b"fixture").hexdigest()

    async def run() -> None:
        with pytest.raises(acceptance.AcceptanceError, match="^provider_failed$"):
            await guard(**_payload())
        with pytest.raises(acceptance.AcceptanceError, match="duplicate_case_call"):
            await guard(**_payload())
    asyncio.run(run())
    assert attempts == [1]
    assert "PRIVATE" not in json.dumps(guard.records)


def test_guard_requires_original_image_before_calling() -> None:
    async def forbidden(**kwargs: Any) -> Any:
        pytest.fail("must not call provider")

    guard = acceptance.GuardedTransport("test-only", forbidden)
    guard.case = "history"
    guard.expected_hash = "0" * 64
    with pytest.raises(acceptance.AcceptanceError, match="image_transport_mismatch"):
        asyncio.run(guard(**_payload()))
    assert not guard.records


def test_official_transport_closes_sdk_when_stream_cleanup_fails(monkeypatch: Any) -> None:
    import httpx
    import openai

    sdk_closed = []
    client_options = []

    class SDK:
        def __init__(self, **kwargs: Any) -> None:
            assert kwargs["max_retries"] == 0
            assert kwargs["base_url"] == "https://api.deepseek.com/v1"

        async def close(self) -> None:
            sdk_closed.append(True)

    class Stream:
        def __aiter__(self) -> Any:
            return self

        async def __anext__(self) -> Any:
            raise StopAsyncIteration

        async def aclose(self) -> None:
            raise RuntimeError("stream cleanup failure")

    async def invoke(**kwargs: Any) -> Any:
        assert isinstance(kwargs["client"], SDK)
        return Stream()

    monkeypatch.setattr(openai, "AsyncOpenAI", SDK)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_options.append(kwargs))

    async def run() -> None:
        stream = await acceptance._official_transport(invoke, **_payload())
        with pytest.raises(RuntimeError, match="stream cleanup failure"):
            async for _ in stream:
                pass
    asyncio.run(run())
    assert sdk_closed == [True]
    assert client_options == [{"trust_env": False, "follow_redirects": False, "timeout": 45}]


def test_dry_run_never_reads_key_or_calls_provider(tmp_path: Path, monkeypatch: Any) -> None:
    monkeypatch.setenv(acceptance.KEY_ENV, "not-used-private-key")
    report = acceptance.run_acceptance(tmp_path)
    assert report["status"] == "dry_run"
    assert report["provider_calls"] == []
    assert len(list((tmp_path / "fixtures").glob("*.png"))) == 3
    assert "not-used-private-key" not in (tmp_path / "report.json").read_text()


def test_execute_without_dedicated_key_fails_without_fallback(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    monkeypatch.delenv(acceptance.KEY_ENV, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "must-not-be-used")
    report = acceptance.run_acceptance(tmp_path, execute=True)
    assert report["status"] == "blocked"
    assert report["error_code"] == "dedicated_api_key_missing"
    assert report["provider_calls"] == []


def test_real_product_path_with_offline_transport_and_no_key_file(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    monkeypatch.setenv(acceptance.KEY_ENV, "synthetic-test-private-key")
    calls = []

    async def offline(invoke: Any, **kwargs: Any) -> Any:
        case = acceptance.CASES[len(calls)]
        calls.append(kwargs)

        async def stream() -> Any:
            yield {"choices": [{"delta": {"content": json.dumps(
                acceptance.EXPECTED[case], ensure_ascii=False,
            )}}]}
            yield {"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 10,
                                             "total_tokens": 30}}
        return stream()

    monkeypatch.setattr(acceptance, "_official_transport", offline)
    from offerpilot import config
    monkeypatch.setattr(config, "save_config", lambda *_: pytest.fail("must not write config"))
    report = acceptance.run_acceptance(tmp_path, execute=True)
    assert report["status"] == "passed", report
    assert len(calls) == len(report["provider_calls"]) == 4
    assert all(case["passed"] for case in report["cases"])
    assert report["cases"][-1]["original_image_resent"]
    assert report["cases"][-1]["text_memory_excluded"]
    assert report["cost"]["currency"] == "CNY"
    assert report["cost"]["estimate"] == 0.00048
    assert report["provider_calls"][-1]["image_sha256"] == report["provider_calls"][-2][
        "image_sha256"
    ]
    assert "synthetic-test-private-key" not in (tmp_path / "report.json").read_text()
    assert "base64" not in (tmp_path / "report.json").read_text()
