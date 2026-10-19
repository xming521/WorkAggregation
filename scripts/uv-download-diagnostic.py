"""Isolated real-uv download probes; never invoke the product's pytest suite.

Fixtures only use loopback URLs and empty per-case caches. The cold-sync mode
uses the repository's unchanged frozen lock with an empty external environment.
Neither mode changes the pytest offline guard or manifest/attempt identity.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile


ROOT = Path(__file__).resolve().parents[1]
WHEEL = "retry_probe-1.0.0-py3-none-any.whl"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def wheel_bytes() -> bytes:
    files = {
        "retry_probe.py": b"VALUE = 'verified fixture'\n",
        "retry_probe-1.0.0.dist-info/METADATA": (
            b"Metadata-Version: 2.1\nName: retry-probe\nVersion: 1.0.0\n\n"
        ),
        "retry_probe-1.0.0.dist-info/WHEEL": (
            b"Wheel-Version: 1.0\nGenerator: diagnostic\nRoot-Is-Purelib: true\n"
            b"Tag: py3-none-any\n\n"
        ),
    }
    record = []
    for name, content in files.items():
        hashed = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=")
        record.append(f"{name},sha256={hashed.decode()},{len(content)}")
    record.append("retry_probe-1.0.0.dist-info/RECORD,,")
    files["retry_probe-1.0.0.dist-info/RECORD"] = ("\n".join(record) + "\n").encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


def clean_env(cache: Path, environment: Path, retries: int) -> dict[str, str]:
    # The diagnostic must not inherit an index override or a pre-populated cache.
    env = {key: value for key, value in os.environ.items() if not key.startswith("UV_")}
    env.update({
        "UV_CACHE_DIR": str(cache), "UV_PROJECT_ENVIRONMENT": str(environment),
        "UV_HTTP_RETRIES": str(retries), "UV_HTTP_CONNECT_TIMEOUT": "10",
        "UV_HTTP_TIMEOUT": "30", "UV_PYTHON_DOWNLOADS": "never",
        "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1",
        "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    })
    return env


def checked_sync(uv: str, project: Path, env: dict[str, str]) -> list[str]:
    """Use an actual shell failure gate before the simulated pytest-stage command."""
    python = Path(env["UV_PROJECT_ENVIRONMENT"]) / (
        "Scripts/python.exe" if os.name == "nt" else "bin/python"
    )
    sentinel = (
        "import retry_probe; from pathlib import Path; "
        "Path('pytest-sentinel').write_text(retry_probe.VALUE)"
    )
    sync = [uv, "sync", "--frozen", "--no-config", "--python", sys.executable]
    if os.name == "nt":
        def quote(value: str) -> str:
            return "'" + value.replace("'", "''") + "'"
        command = "& " + " ".join(map(quote, sync))
        command += '; if ($LASTEXITCODE -ne 0) { throw "Frozen Python install failed" }; '
        command += "& " + " ".join(map(quote, [str(python), "-c", sentinel]))
        command += "; exit $LASTEXITCODE"
        return ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command]
    command = shlex.join(sync)
    command += '; status=$?; if [ "$status" -ne 0 ]; then exit "$status"; fi; '
    command += shlex.join([str(python), "-c", sentinel])
    return ["bash", "-c", command]


def fixture(output: Path, uv: str, name: str, retries: int,
            failures: int, status: int, expected_requests: int,
            expected_success: bool, expected_error: str = "") -> dict:
    project = output / name
    project.mkdir()
    payload = wheel_bytes()
    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append({"path": self.path, "time": time.monotonic()})
            if self.path != "/" + WHEEL:
                code, body = 404, b"Unexpected URL: fixture forbids external resolution"
            elif len(requests) <= failures:
                code, body = status, b"Controlled download failure"
            else:
                code, body = 200, payload
            self.send_response(code)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    env = clean_env(project / "cache", project / ".venv", retries)
    for key in list(env):
        if key.upper() in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}:
            env.pop(key)
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env["UV_DEFAULT_INDEX"] = base + "/simple"
    project.joinpath("pyproject.toml").write_text(
        '[project]\nname = "retry-fixture"\nversion = "0.0.0"\n'
        'requires-python = ">=3.12"\ndependencies = ["retry-probe==1.0.0"]\n',
        encoding="utf-8",
    )
    hashed = "0" * 64 if name == "wrong-hash" else hashlib.sha256(payload).hexdigest()
    lock = (
        'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n\n'
        '[[package]]\nname = "retry-fixture"\nversion = "0.0.0"\n'
        'source = { virtual = "." }\ndependencies = [{ name = "retry-probe" }]\n\n'
        '[[package]]\nname = "retry-probe"\nversion = "1.0.0"\n'
        f'source = {{ registry = "{base}/simple" }}\n'
        f'wheels = [{{ url = "{base}/{WHEEL}", hash = "sha256:{hashed}", '
        f'size = {len(payload)} }}]\n'
    )
    if name == "build-failure":
        project.joinpath("pyproject.toml").write_text(
            '[project]\nname = "retry-fixture"\nversion = "0.0.0"\n'
            'requires-python = ">=3.12"\n[build-system]\nrequires = []\n'
            'build-backend = "broken_backend"\nbackend-path = ["."]\n',
            encoding="utf-8",
        )
        project.joinpath("broken_backend.py").write_text(
            'raise RuntimeError("CONTROLLED_BUILD_FAILURE")\n', encoding="utf-8",
        )
        lock = (
            'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n\n'
            '[[package]]\nname = "retry-fixture"\nversion = "0.0.0"\n'
            'source = { editable = "." }\n'
        )
    project.joinpath("uv.lock").write_text(lock, encoding="utf-8")
    before = digest(project / "uv.lock")
    started = time.monotonic()
    try:
        result = subprocess.run(checked_sync(uv, project, env), cwd=project, env=env,
                                capture_output=True, text=True, encoding="utf-8", timeout=240)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    log = result.stdout + result.stderr
    output.joinpath(name + ".log").write_text(log, encoding="utf-8")
    row = {
        "case": name, "retries": retries, "exit_code": result.returncode,
        "request_count": len(requests), "expected_request_count": expected_requests,
        "requests": requests, "sentinel_exists": (project / "pytest-sentinel").exists(),
        "lock_before": before, "lock_after": digest(project / "uv.lock"),
        "elapsed_seconds": round(time.monotonic() - started, 3),
    }
    row["passed"] = (
        (result.returncode == 0) == expected_success
        and row["sentinel_exists"] == expected_success
        and len(requests) == expected_requests
        and row["lock_before"] == row["lock_after"]
        and (not expected_error or expected_error.lower() in log.lower())
    )
    print(json.dumps(row), flush=True)
    return row


def fixtures(output: Path, uv: str) -> list[dict]:
    return [fixture(output, uv, *case) for case in [
        ("old-three-retries", 3, 4, 503, 4, False, "503"),
        ("new-six-retries", 6, 4, 503, 5, True, ""),
        ("permanent-503", 6, 100, 503, 7, False, "503"),
        ("not-found-404", 6, 100, 404, 1, False, "404"),
        ("wrong-hash", 6, 0, 200, 1, False, "hash mismatch"),
        ("build-failure", 6, 0, 200, 0, False, "CONTROLLED_BUILD_FAILURE"),
    ]]


def cold_sync(output: Path, uv: str) -> dict:
    fresh = Path(tempfile.mkdtemp(prefix="cold-sync-", dir=output))
    env = clean_env(fresh / "cache", fresh / "venv", 6)
    before = digest(ROOT / "uv.lock")
    started = time.monotonic()
    command = [uv, "sync", "--frozen"]
    timed_out = False
    with output.joinpath("cold-sync.log").open("w", encoding="utf-8") as log:
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=600)
            exit_code = result.returncode
        except subprocess.TimeoutExpired:
            timed_out, exit_code = True, 124
            log.write("\nCold-cache diagnostic exceeded its 600-second measurement budget.\n")
    elapsed = round(time.monotonic() - started, 3)
    row = {
        "case": "cold-cache-full-frozen-sync", "command": command,
        "exit_code": exit_code, "elapsed_seconds": elapsed, "timed_out": timed_out,
        "lock_before": before, "lock_after": digest(ROOT / "uv.lock"),
        "cache_started_empty": True, "cache_dir": str(fresh / "cache"),
        "environment_dir": str(fresh / "venv"),
        "five_minute_margin_seconds": round(300 - elapsed, 3),
        "passed": exit_code == 0 and before == digest(ROOT / "uv.lock"),
    }
    print(json.dumps(row), flush=True)
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["fixtures", "cold-sync"])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-version", default="0.12.19")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError("uv executable missing")
    version = subprocess.check_output([uv, "--version"], text=True).strip()
    if version.split()[1] != args.expected_version:
        raise RuntimeError(f"Expected uv {args.expected_version}, found {version}")
    before = digest(ROOT / "uv.lock")
    rows = fixtures(output, uv) if args.mode == "fixtures" else [cold_sync(output, uv)]
    report = {
        "uv": version, "python": sys.version, "platform": sys.platform,
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT,
                                          text=True).strip(),
        "run_id": os.environ.get("GITHUB_RUN_ID", "local"),
        "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "local"),
        "product_lock_before": before, "product_lock_after": digest(ROOT / "uv.lock"),
        "results": rows,
        "passed": all(row["passed"] for row in rows) and before == digest(ROOT / "uv.lock"),
    }
    output.joinpath(args.mode + "-summary.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8",
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
