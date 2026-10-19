#!/usr/bin/env python3
"""One bounded, cold-cache frozen sync and evidence collection (Python 3.11+).

No product tests, dependency upgrades, lock writes, or retry of the sync itself.
Run helper checks without installation: python pypi_frozen_install_probe.py --self-test
HTTP setting reference: https://docs.astral.sh/uv/reference/environment/
"""

from __future__ import annotations

import argparse
import email.parser
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import unittest
from urllib.parse import urlsplit, urlunsplit
from urllib.request import url2pathname

EXPECTED_UV = "0.12.19"
SYNC_TIMEOUT_SECONDS = 270
OFFICIAL_HOSTS = {"pypi.org", "files.pythonhosted.org"}
URL_RE = re.compile(r"https?://[^\s<>\"'`]+", re.IGNORECASE)
NETWORK_RE = re.compile(r"request|response|fetch|download|\bGET\b|\bHEAD\b|retry", re.I)
BUILD_RE = re.compile(r"hatchling|build (?:requirement|dependenc)|build backend", re.I)


class ProbeError(RuntimeError):
    """A fail-closed preflight, identity, or evidence validation failure."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_lf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n")


def normalize_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProbeError(message)


def is_within(child: Path, parent: Path) -> bool:
    return child.resolve().is_relative_to(parent.resolve())


def check_fresh_external(path: Path, project: Path) -> dict:
    require(path.is_absolute(), "Cache/environment path is not absolute")
    require(not is_within(path, project), "Cache/environment is inside the project")
    require(not is_within(project, path), "Cache/environment contains the project")
    require(not path.is_symlink(), "Cache/environment must not be a symlink")
    exists = path.exists()
    require(not exists or path.is_dir(), "Cache/environment is not a directory")
    require(not exists or not any(path.iterdir()), "Cache/environment is not empty")
    return {"path": str(path), "existed_before": exists, "empty_before": True}


def check_official_url(value: str, *, registry: bool) -> None:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ProbeError("Malformed source URL") from exc
    require(parsed.scheme == "https", "Source must use HTTPS")
    require(not parsed.username and not parsed.password, "Source contains credentials")
    require(port is None, "Source contains a noncanonical port")
    require(not parsed.query and not parsed.fragment, "Source has query/fragment")
    if registry:
        require(parsed.netloc == "pypi.org", "Registry is not official PyPI")
        require(parsed.path.rstrip("/") == "/simple", "Registry path is not /simple")
    else:
        require(parsed.netloc == "files.pythonhosted.org", "Artifact is not official PyPI")
        require(parsed.path.startswith("/packages/"), "Artifact path is not /packages/")


def check_lock_sources(lock: dict, project_data: dict) -> dict:
    packages = lock.get("package", [])
    require(bool(packages), "Lock has no packages")
    root = project_data["project"]
    root_identity = (normalize_name(root["name"]), root["version"])
    editable = []
    registries = 0
    artifact_count = 0
    identities = []
    for package in packages:
        identity = (normalize_name(package["name"]), package["version"])
        identities.append(identity)
        source = package.get("source", {})
        if set(source) == {"registry"}:
            check_official_url(source["registry"], registry=True)
            registries += 1
            artifacts = package.get("wheels", []) + (
                [package["sdist"]] if "sdist" in package else []
            )
            require(bool(artifacts), "Registry package has no locked artifact")
            for artifact in artifacts:
                check_official_url(artifact["url"], registry=False)
                require(
                    bool(re.fullmatch(r"sha256:[a-f0-9]{64}", artifact.get("hash", ""))),
                    "Artifact has no valid locked SHA256",
                )
                artifact_count += 1
        else:
            require(source == {"editable": "."}, "Unexpected non-registry package source")
            require(identity == root_identity, "Editable project identity differs from pyproject")
            editable.append(identity)
    require(len(editable) == 1, "Expected exactly one editable root project")

    # Source references also occur in dependency tables, not just package.source.
    def visit(value: object, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                visit(child, child_key)
        elif isinstance(value, list):
            for child in value:
                visit(child, key)
        elif isinstance(value, str):
            if key == "registry":
                check_official_url(value, registry=True)
            elif key == "url":
                check_official_url(value, registry=False)
            elif "://" in value:
                raise ProbeError("Unexpected URL-bearing lock field")

    visit(lock)
    return {
        "package_count": len(packages),
        "registry_package_count": registries,
        "artifact_count": artifact_count,
        "editable_project": list(root_identity),
        "locked_identities": [list(item) for item in sorted(set(identities))],
        "all_registry_and_artifact_urls_official": True,
    }


def safe_url(raw: str) -> str:
    raw = raw.rstrip(".,;)]}")
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname or "invalid-host"
        if parsed.port:
            host += f":{parsed.port}"
        if parsed.username is not None or parsed.password is not None:
            host = "[REDACTED]@" + host
        return urlunsplit((parsed.scheme, host, parsed.path,
                           "[REDACTED]" if parsed.query else "", ""))
    except ValueError:
        return "https://[REDACTED-INVALID-URL]"


class Redactor:
    def __init__(self, environment: dict[str, str]):
        self.secrets = sorted({
            value for key, value in environment.items()
            if re.search(r"TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY", key, re.I)
            and len(value) >= 4
        }, key=len, reverse=True)

    def __call__(self, value: str) -> str:
        value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
        for secret in self.secrets:
            value = value.replace(secret, "[REDACTED]")
        value = URL_RE.sub(lambda match: safe_url(match.group()), value)
        value = re.sub(r"(?i)(authorization\s*[:=]\s*)[^\r\n]+", r"\1[REDACTED]", value)
        return re.sub(
            r"(?i)((?:token|password|secret)\s*[:=]\s*)\S+",
            r"\1[REDACTED]", value,
        )


def run_readonly(command: list[str], cwd: Path, timeout: int = 5) -> str:
    result = subprocess.run(command, cwd=cwd, text=True, encoding="utf-8", errors="replace",
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    require(result.returncode == 0, f"Read-only command failed: {command[0]}")
    return result.stdout.strip()


def snapshot(project: Path) -> dict:
    result = {
        "git_head": run_readonly(["git", "rev-parse", "HEAD"], project),
        "tracked_status": run_readonly(
            ["git", "status", "--porcelain=v1", "--untracked-files=no"], project
        ),
        "files": {},
    }
    for name in ("uv.lock", "pyproject.toml"):
        path = project / name
        require(path.resolve().parent == project.resolve(), f"{name} resolves outside project")
        data = path.read_bytes()
        result["files"][name] = {
            "bytes": len(data), "sha256_raw": sha256(data),
            "sha256_canonical_lf": sha256(canonical_lf(data)),
        }
    return result


def check_snapshot(actual: dict, expected_commit: str, expected_lock_sha: str) -> None:
    require(bool(re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", expected_commit)),
            "Expected commit must be a full lowercase SHA")
    require(bool(re.fullmatch(r"[a-f0-9]{64}", expected_lock_sha)),
            "Expected lock hash must be a lowercase SHA256")
    require(actual["git_head"] == expected_commit, "HEAD does not match expected commit")
    require(not actual["tracked_status"], "Tracked project files are dirty")
    require(actual["files"]["uv.lock"]["sha256_canonical_lf"] == expected_lock_sha,
            "Canonical LF lock hash mismatch")


def clean_environment(inherited: dict[str, str], cache: Path, venv: Path) -> dict[str, str]:
    environment = {
        key: value for key, value in inherited.items()
        if not key.upper().startswith("UV_")
        and key.upper() not in {"VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH"}
    }
    environment.update({
        "UV_CACHE_DIR": str(cache), "UV_PROJECT_ENVIRONMENT": str(venv),
        "UV_DEFAULT_INDEX": "https://pypi.org/simple", "UV_HTTP_RETRIES": "6",
        "UV_HTTP_CONNECT_TIMEOUT": "10", "UV_HTTP_TIMEOUT": "30",
        "UV_PYTHON_DOWNLOADS": "never", "UV_KEYRING_PROVIDER": "disabled",
        "UV_NO_PROGRESS": "1", "NO_COLOR": "1",
    })
    return environment


class BuildMetadataWatcher:
    """Copy actual dist-info bytes before ephemeral build environments disappear."""

    def __init__(self, cache: Path, output: Path):
        self.cache = cache
        self.output = output / "build-metadata"
        self.output.mkdir()
        self.stop_event = threading.Event()
        self.observations: list[dict] = []
        self.errors: list[str] = []
        self.seen: set[tuple[str, str]] = set()
        self.scans = 0
        self.started = time.monotonic()
        self.thread = threading.Thread(target=self._watch, daemon=True)

    def _capture(self, path: Path, kind: str) -> None:
        try:
            before = path.stat()
            data = path.read_bytes()
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                return
            if len(data) != after.st_size:
                return
            metadata = email.parser.BytesParser().parsebytes(data, headersonly=True)
            name, version = metadata.get("Name"), metadata.get("Version")
            if not name or not version or not metadata.get("Metadata-Version"):
                return
            if kind == "retained_archive" and normalize_name(name) != "hatchling":
                return
            digest = sha256(data)
            key = (str(path), digest)
            if key in self.seen:
                return
            saved = self.output / f"{kind}-{digest}.METADATA"
            saved.write_bytes(data)
            self.observations.append({
                "kind": kind, "path": str(path), "resolved_path": str(path.resolve()),
                "name": name, "version": version, "metadata_sha256": digest,
                "metadata_bytes": len(data), "saved_file": str(saved.relative_to(self.output.parent)),
                "observed_after_seconds": round(time.monotonic() - self.started, 6),
                "hash_meaning": "Exact observed dist-info/METADATA bytes, not wheel archive SHA256",
            })
            self.seen.add(key)
        except (OSError, ValueError):
            # Creation/deletion races are expected; absence remains an explicit evidence gap.
            return

    def scan(self, kind: str = "ephemeral_build_environment") -> None:
        root = self.cache / ("builds-v0" if kind == "ephemeral_build_environment" else "archive-v0")
        self.scans += 1
        if not root.exists():
            return
        try:
            for directory, dirs, files in os.walk(root):
                if directory.endswith(".dist-info"):
                    if "METADATA" in files:
                        self._capture(Path(directory) / "METADATA", kind)
                    dirs[:] = []
                else:
                    # Only descend cache root, temporary env and site-packages hierarchy.
                    dirs[:] = [name for name in dirs if not name.startswith("__pycache__")]
        except OSError as exc:
            self.errors.append(type(exc).__name__)

    def _watch(self) -> None:
        try:
            while not self.stop_event.is_set():
                self.scan()
                self.stop_event.wait(0.04)
        except Exception as exc:  # Preserve the install and report observer failure separately.
            self.errors.append(type(exc).__name__)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            self.errors.append("watcher_did_not_stop")
        else:
            self.scan()
            self.scan("retained_archive")


def kill_process_tree(process: subprocess.Popen) -> dict:
    result = {"requested": True, "tree_kill": False}
    if os.name == "nt":
        try:
            killed = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
            )
            result["tree_kill"] = killed.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
            result["tree_kill"] = True
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        result["still_running"] = True
    return result


def sync_once(command: list[str], project: Path, environment: dict[str, str], output: Path,
              redactor: Redactor, watcher: BuildMetadataWatcher) -> dict:
    started = time.monotonic()
    result: dict = {"command": command, "timeout_seconds": SYNC_TIMEOUT_SECONDS,
                    "timed_out": False, "invocation_count": 1}
    log = output / "uv-sync.verbose.safe.log"
    reader_errors: list[str] = []
    watcher.start()
    process = None
    try:
        options = {"start_new_session": True} if os.name != "nt" else {
            "creationflags": subprocess.CREATE_NEW_PROCESS_GROUP,
        }
        process = subprocess.Popen(command, cwd=project, env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding="utf-8", errors="replace", **options)

        def consume() -> None:
            try:
                with log.open("w", encoding="utf-8", newline="\n") as handle:
                    for line in process.stdout:
                        safe = redactor(line)
                        handle.write(safe)
                        handle.flush()
                        # Prefix prevents backend output acting as an Actions workflow command.
                        print("[uv] " + safe.rstrip("\r\n"), flush=True)
            except Exception as exc:
                reader_errors.append(type(exc).__name__)

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        try:
            result["returncode"] = process.wait(timeout=SYNC_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            result["timed_out"] = True
            result["termination"] = kill_process_tree(process)
            result["returncode"] = process.poll()
        reader.join(timeout=2)
        result["log_reader_complete"] = not reader.is_alive()
        result["log_reader_errors"] = reader_errors
    finally:
        if process is not None and process.poll() is None:
            result["termination"] = kill_process_tree(process)
        result["elapsed_seconds"] = round(time.monotonic() - started, 6)
        watcher.stop()
    result["safe_log"] = log.name
    result["safe_log_sha256"] = sha256(log.read_bytes()) if log.exists() else None
    return result


# Run only with the newly created venv Python. No package imports or package commands.
INSTALLED_METADATA_CODE = r'''
import hashlib, importlib.metadata, json, pathlib, sys
result = {"executable": sys.executable, "prefix": sys.prefix, "base_prefix": sys.base_prefix,
          "python_version": sys.version, "distributions": [], "errors": []}
for distribution in importlib.metadata.distributions():
    name, version = distribution.metadata.get("Name"), distribution.version
    row = {"name": name, "version": version, "files": {}}
    files = list(distribution.files or [])
    for filename in ("METADATA", "RECORD", "WHEEL"):
        matches = [p for p in files if p.name == filename and str(p.parent).endswith(".dist-info")]
        if len(matches) != 1:
            result["errors"].append({"name": name, "file": filename, "matches": len(matches)})
            continue
        path = pathlib.Path(distribution.locate_file(matches[0])).resolve()
        try:
            data = path.read_bytes()
            row["files"][filename] = {"path": str(path), "bytes": len(data),
                "sha256_installed_bytes": hashlib.sha256(data).hexdigest()}
        except OSError as exc:
            result["errors"].append({"name": name, "file": filename, "error": type(exc).__name__})
    direct = distribution.read_text("direct_url.json")
    if direct is not None:
        row["direct_url"] = json.loads(direct)
    result["distributions"].append(row)
result["distributions"].sort(key=lambda row: (row["name"] or "", row["version"] or ""))
print(json.dumps(result))
'''


def validate_installed(actual: dict, locked: dict, venv: Path, project: Path | None = None) -> None:
    require(Path(actual["prefix"]).resolve() == venv.resolve(), "Metadata Python is not target venv")
    require(actual["prefix"] != actual["base_prefix"], "Metadata Python is not isolated")
    require(not actual["errors"], "Installed METADATA/RECORD/WHEEL evidence missing")
    allowed = {tuple(item) for item in locked["locked_identities"]}
    observed: set[tuple[str, str]] = set()
    names: set[str] = set()
    for item in actual["distributions"]:
        require(bool(item["name"]) and bool(item["version"]), "Installed identity missing")
        identity = (normalize_name(item["name"]), item["version"])
        require(identity in allowed, f"Installed name/version absent from lock: {identity}")
        require(identity[0] not in names, f"Duplicate installed distribution: {identity[0]}")
        observed.add(identity)
        names.add(identity[0])
        if identity == tuple(locked["editable_project"]) and project is not None:
            direct = item.get("direct_url", {})
            require(direct.get("dir_info", {}).get("editable") is True,
                    "Installed root project lacks editable direct_url evidence")
            source = urlsplit(direct.get("url", ""))
            require(source.scheme == "file" and source.netloc in {"", "localhost"},
                    "Editable project direct_url is not a local path")
            installed_source = Path(url2pathname(source.path)).resolve()
            require(installed_source == project.resolve(), "Editable source path differs from project")
        require(set(item["files"]) == {"METADATA", "RECORD", "WHEEL"},
                "Installed distribution metadata incomplete")
        for file in item["files"].values():
            require(is_within(Path(file["path"]), venv), "Installed metadata is outside target venv")
    require(tuple(locked["editable_project"]) in observed, "Editable project is not installed")


def summarize_log(log: Path) -> dict:
    urls: dict[str, dict] = {}
    build_lines = []
    forbidden = []
    for number, line in enumerate(log.read_text(encoding="utf-8").splitlines(), 1):
        if BUILD_RE.search(line):
            build_lines.append({"line": number, "text": line})
        for match in URL_RE.finditer(line):
            url = safe_url(match.group())
            try:
                host = urlsplit(url).hostname or ""
            except ValueError:
                host = "invalid-host"
            network_context = bool(NETWORK_RE.search(line))
            entry = urls.setdefault(url, {"url_redacted": url, "host": host,
                                         "observations": []})
            entry["observations"].append({"line": number, "network_context": network_context,
                                          "context": line})
            if "tuna" in host.lower() or (network_context and host not in OFFICIAL_HOSTS):
                forbidden.append({"line": number, "url_redacted": url})
    return {
        "urls_observed_in_verbose_log": list(urls.values()),
        "build_requirement_and_hatchling_lines": build_lines,
        "forbidden_source_observations": forbidden,
        "coverage": "Log-observed URLs and contexts; not packet capture or proof every URL was fetched",
    }


def hatchling_evidence(watcher: BuildMetadataWatcher, log_data: dict) -> dict:
    hatchling = [item for item in watcher.observations if normalize_name(item["name"]) == "hatchling"]
    ephemeral = [item for item in hatchling if item["kind"] == "ephemeral_build_environment"]
    archives = [item for item in hatchling if item["kind"] == "retained_archive"]
    versions = sorted({item["version"] for item in ephemeral})
    relevant = log_data["build_requirement_and_hatchling_lines"]
    links = [line for line in relevant if "hatchling" in line["text"].lower()]
    version_links = [line for line in links if any(
        re.search(r"(?<![\w.])" + re.escape(version) + r"(?![\w.])", line["text"])
        for version in versions
    )]
    consistent = len(versions) == 1 and all(item["version"] == versions[0] for item in archives)
    byte_matches = [item["metadata_sha256"] for item in ephemeral if any(
        other["metadata_sha256"] == item["metadata_sha256"] for other in archives
    )]
    proved = bool(ephemeral and consistent and version_links)
    return {
        "actual_build_environment_version_proved": proved,
        "evidence_level": ("ephemeral_build_env_metadata_and_matching_verbose_version" if proved
                           else "unproved_actual_backend_version"),
        "actual_versions": versions, "metadata_observations": hatchling,
        "debug_hatchling_lines": links, "matching_version_lines": version_links,
        "consistent_observed_versions": consistent,
        "ephemeral_and_archive_identical_metadata_sha256": sorted(set(byte_matches)),
        "limitations": [
            "Observed installed metadata in uv's ephemeral build environment; no backend instrumentation",
            "Retained archive metadata alone does not prove which backend executed",
            "Existing unpinned hatchling build requirement is resolved by normal frozen sync",
        ],
    }


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def execute(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    output = Path(args.output).resolve()
    require(project.is_dir(), "Project directory missing")
    require(not is_within(output, project), "Evidence output must be external to project")
    require(not (output / "probe-report.json").exists(), "Refusing to overwrite an existing report")
    output.mkdir(parents=True, exist_ok=True)
    redactor = Redactor(dict(os.environ))
    started = time.monotonic()
    report: dict = {"schema_version": 1, "result": "started", "errors": [], "evidence_gaps": [],
                    "expected_commit": args.expected_commit,
                    "expected_lock_lf_sha256": args.expected_lock_lf_sha,
                    "project": str(project), "output": str(output),
                    "product_tests_run": False, "sync_attempts": 0,
                    "metadata_hashes_are_not_archive_hashes": True}
    exit_code = 1
    watcher = None
    before = None
    try:
        before = snapshot(project)
        report["before"] = before
        check_snapshot(before, args.expected_commit, args.expected_lock_lf_sha)
        lock = tomllib.loads((project / "uv.lock").read_text(encoding="utf-8"))
        project_data = tomllib.loads((project / "pyproject.toml").read_text(encoding="utf-8"))
        report["lock_sources"] = check_lock_sources(lock, project_data)
        report["build_system"] = project_data.get("build-system", {})
        require(report["build_system"] == {
            "requires": ["hatchling"], "build-backend": "hatchling.build",
        }, "Build system differs from the expected existing unpinned hatchling configuration")
        uv = shutil.which("uv")
        require(uv is not None, "uv is not on PATH")
        uv_version = run_readonly([uv, "--version"], project)
        require(bool(re.match(r"^uv " + re.escape(EXPECTED_UV) + r"(?:\s|$)", uv_version)),
                "uv version differs from 0.12.19")
        report["tool_identity"] = {
            "uv_version": uv_version, "uv_executable": uv, "uv_sha256": sha256(Path(uv).read_bytes()),
            "python_executable": sys.executable, "python_version": sys.version,
            "python_sha256": sha256(Path(sys.executable).read_bytes()),
            "harness_sha256": sha256(Path(__file__).read_bytes()),
        }
        sandbox = Path(tempfile.mkdtemp(prefix="pypi-frozen-install-")).resolve()
        cache, venv = sandbox / "cache", sandbox / "venv"
        report["fresh_paths"] = {
            "cache": check_fresh_external(cache, project),
            "environment": check_fresh_external(venv, project), "sandbox": str(sandbox),
        }
        require(not is_within(cache, venv) and not is_within(venv, cache),
                "Cache/environment paths overlap")
        env = clean_environment(dict(os.environ), cache, venv)
        report["controlled_uv_environment"] = {key: value for key, value in env.items()
                                               if key.startswith("UV_")}
        report["inherited_uv_variables_removed_count"] = sum(
            key.upper().startswith("UV_") for key in os.environ
        )
        report["preflight_passed"] = True
        write_json(output / "preflight.json", report)
        watcher = BuildMetadataWatcher(cache, output)
        command = [uv, "sync", "--frozen", "--no-config", "--python", sys.executable, "--verbose"]
        report["sync_attempts"] = 1
        report["sync"] = sync_once(command, project, env, output, redactor, watcher)
        report["log_evidence"] = summarize_log(output / "uv-sync.verbose.safe.log")
        write_json(output / "network-and-build-log-evidence.json", report["log_evidence"])
        report["hatchling"] = hatchling_evidence(watcher, report["log_evidence"])
        if report["hatchling"]["actual_versions"]:
            require(report["hatchling"]["consistent_observed_versions"],
                    "Conflicting hatchling versions in observed build/cache metadata")
        report["build_metadata_observer"] = {
            "scans": watcher.scans, "errors": watcher.errors,
            "all_build_metadata_observations": watcher.observations,
        }
        if not report["hatchling"]["actual_build_environment_version_proved"]:
            report["evidence_gaps"].append("Actual hatchling backend version is not proved")
        if watcher.errors:
            report["evidence_gaps"].append("Build metadata observer reported errors")
        if not report["sync"]["log_reader_complete"] or report["sync"]["log_reader_errors"]:
            report["evidence_gaps"].append("Verbose log capture was incomplete")
        require(not report["log_evidence"]["forbidden_source_observations"],
                "Verbose log contains a TUNA or other nonofficial network source")
        require(not report["sync"]["timed_out"], "Single sync exceeded its hard time bound")
        require(report["sync"]["returncode"] == 0, "uv sync failed")
        python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        result = subprocess.run([str(python), "-I", "-c", INSTALLED_METADATA_CODE],
                                cwd=output, env=env, text=True, encoding="utf-8", errors="replace",
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        report["installed_metadata_probe_exit"] = result.returncode
        require(result.returncode == 0, "Installed metadata inspection failed")
        installed = json.loads(result.stdout)
        installed["hash_meaning"] = "SHA256 of installed metadata files, not original distribution archives"
        write_json(output / "installed-distributions.json", installed)
        report["installed_distribution_count"] = len(installed["distributions"])
        validate_installed(installed, report["lock_sources"], venv, project)
        report["installed_names_versions_all_in_lock"] = True
        exit_code = 3 if report["evidence_gaps"] else 0
        report["result"] = "evidence_incomplete" if exit_code else "passed"
    except Exception as exc:
        report["result"] = "failed"
        report["errors"].append(redactor(f"{type(exc).__name__}: {exc}"))
        if report.get("sync", {}).get("timed_out"):
            exit_code = 124
        elif report.get("sync", {}).get("returncode"):
            code = report["sync"]["returncode"]
            exit_code = code if 0 < code < 126 else 1
        else:
            exit_code = 1
    finally:
        if before is not None:
            try:
                after = snapshot(project)
                report["after"] = after
                report["identity_unchanged"] = after == before
                check_snapshot(after, args.expected_commit, args.expected_lock_lf_sha)
                require(after == before, "HEAD, tracked status, lock, or pyproject changed during probe")
            except Exception as exc:
                report["errors"].append(redactor(f"Postflight: {type(exc).__name__}: {exc}"))
                report["result"] = "failed"
                exit_code = 1
        report["elapsed_seconds"] = round(time.monotonic() - started, 6)
        report["exit_code"] = exit_code
        write_json(output / "probe-report.json", report)
        print(json.dumps({"result": report["result"], "exit_code": exit_code,
                          "report": str(output / "probe-report.json"),
                          "errors": report["errors"], "evidence_gaps": report["evidence_gaps"]}), flush=True)
    return exit_code


class HelperChecks(unittest.TestCase):
    def test_lf_and_crlf_hash_equivalence(self):
        self.assertEqual(sha256(canonical_lf(b"a\r\nb\r\n")), sha256(b"a\nb\n"))
        self.assertNotEqual(sha256(b"a\r\n"), sha256(b"a\n"))

    def test_source_acceptance_and_rejections(self):
        check_official_url("https://pypi.org/simple", registry=True)
        check_official_url("https://files.pythonhosted.org/packages/a/x.whl", registry=False)
        for value in ("https://pypi.tuna.tsinghua.edu.cn/simple", "http://pypi.org/simple",
                      "https://pypi.org.attacker.test/simple", "https://user:pw@pypi.org/simple",
                      "https://pypi.org/simple?token=x", "https://pypi.org:443/simple"):
            with self.subTest(value=value), self.assertRaises(ProbeError):
                check_official_url(value, registry=True)
        with self.assertRaises(ProbeError):
            check_official_url("https://files.pythonhosted.org/other/x.whl", registry=False)

    def test_fresh_external_paths(self):
        with tempfile.TemporaryDirectory() as root:
            project = Path(root) / "project"
            project.mkdir()
            fresh = Path(root) / "fresh"
            self.assertFalse(check_fresh_external(fresh, project)["existed_before"])
            fresh.mkdir()
            self.assertTrue(check_fresh_external(fresh, project)["empty_before"])
            (fresh / "used").write_bytes(b"x")
            for path in (fresh, project / ".venv", Path(root)):
                with self.subTest(path=path), self.assertRaises(ProbeError):
                    check_fresh_external(path, project)

    def test_environment_cleaning(self):
        env = clean_environment({"UV_INDEX_URL": "bad", "uv_extra_index_url": "bad",
                                 "UV_TOKEN": "hidden", "PATH": "keep", "PYTHONPATH": "bad"},
                                Path("/cold/cache"), Path("/cold/venv"))
        self.assertEqual(env["UV_HTTP_RETRIES"], "6")
        self.assertEqual(env["UV_HTTP_CONNECT_TIMEOUT"], "10")
        self.assertEqual(env["UV_HTTP_TIMEOUT"], "30")
        self.assertEqual(env["UV_PYTHON_DOWNLOADS"], "never")
        self.assertNotIn("UV_TOKEN", env)
        self.assertNotIn("UV_INDEX_URL", env)
        self.assertNotIn("PYTHONPATH", env)
        self.assertNotIn("uv_extra_index_url", env)
        self.assertEqual(env["PATH"], "keep")

    def test_snapshot_negative_controls(self):
        commit, digest = "a" * 40, "b" * 64
        actual = {"git_head": commit, "tracked_status": "", "files": {
            "uv.lock": {"sha256_canonical_lf": digest}}}
        check_snapshot(actual, commit, digest)
        for bad_commit, bad_digest in (("c" * 40, digest), (commit, "c" * 64), ("a", digest)):
            with self.assertRaises(ProbeError):
                check_snapshot(actual, bad_commit, bad_digest)
        actual["tracked_status"] = " M uv.lock"
        with self.assertRaises(ProbeError):
            check_snapshot(actual, commit, digest)

    def test_dependency_source_and_editable_checks(self):
        root = {"project": {"name": "example", "version": "1"}}
        lock = {"package": [{"name": "example", "version": "1", "source": {"editable": "."}}]}
        check_lock_sources(lock, root)
        lock["package"][0]["dependencies"] = [{"name": "x", "source": {
            "registry": "https://pypi.tuna.tsinghua.edu.cn/simple"}}]
        with self.assertRaises(ProbeError):
            check_lock_sources(lock, root)
        lock["package"][0].pop("dependencies")
        lock["package"][0]["version"] = "2"
        with self.assertRaises(ProbeError):
            check_lock_sources(lock, root)

    def test_log_redaction_and_source_detection(self):
        redact = Redactor({"API_TOKEN": "example-secret"})
        text = redact("GET https://user:password@pypi.org/simple?token=abc example-secret")
        for secret in ("password", "user", "abc", "example-secret"):
            self.assertNotIn(secret, text)
        self.assertNotIn("unknown-token", redact("Authorization: Bearer unknown-token"))
        with tempfile.TemporaryDirectory() as root:
            log = Path(root) / "log"
            log.write_text("DEBUG GET https://pypi.tuna.tsinghua.edu.cn/simple/x\n")
            self.assertTrue(summarize_log(log)["forbidden_source_observations"])

    def test_archive_is_not_backend_execution_proof(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            watcher = BuildMetadataWatcher(base / "cache", base)
            path = base / "cache/archive-v0/id/hatchling-1.0.dist-info/METADATA"
            path.parent.mkdir(parents=True)
            content = b"Metadata-Version: 2.4\nName: hatchling\nVersion: 1.0\n\nExact body\n"
            path.write_bytes(content)
            watcher.scan("retained_archive")
            log = {"build_requirement_and_hatchling_lines": [{"line": 1,
                    "text": "DEBUG Selecting: hatchling==1.0"}]}
            self.assertFalse(hatchling_evidence(watcher, log)["actual_build_environment_version_proved"])
            target = base / "cache/builds-v0/.tmpA/Lib/site-packages/hatchling-1.0.dist-info/METADATA"
            target.parent.mkdir(parents=True)
            target.write_bytes(content)
            watcher.scan()
            evidence = hatchling_evidence(watcher, log)
            self.assertTrue(evidence["actual_build_environment_version_proved"])
            self.assertEqual(evidence["ephemeral_and_archive_identical_metadata_sha256"], [sha256(content)])
            saved = base / watcher.observations[0]["saved_file"]
            self.assertEqual(saved.read_bytes(), content)

    def test_installed_identity_and_metadata_negative_controls(self):
        venv = Path(tempfile.gettempdir()) / "probe-unit-venv"
        locked = {"locked_identities": [["example", "1"]], "editable_project": ["example", "1"]}
        actual = {"prefix": str(venv), "base_prefix": "/base", "errors": [], "distributions": [{
            "name": "example", "version": "1", "files": {
                filename: {"path": str(venv / "Lib/site-packages/example.dist-info" / filename)}
                for filename in ("METADATA", "RECORD", "WHEEL")}}]}
        validate_installed(actual, locked, venv)
        actual["distributions"][0]["version"] = "2"
        with self.assertRaises(ProbeError):
            validate_installed(actual, locked, venv)
        actual["distributions"][0]["version"] = "1"
        project = Path(tempfile.gettempdir()) / "probe-unit-project"
        with self.assertRaises(ProbeError):
            validate_installed(actual, locked, venv, project)
        actual["distributions"][0]["direct_url"] = {
            "url": project.as_uri(), "dir_info": {"editable": True},
        }
        validate_installed(actual, locked, venv, project)
        actual["distributions"][0]["direct_url"]["dir_info"]["editable"] = False
        with self.assertRaises(ProbeError):
            validate_installed(actual, locked, venv, project)
        actual["distributions"][0]["files"].pop("WHEEL")
        with self.assertRaises(ProbeError):
            validate_installed(actual, locked, venv)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project")
    parser.add_argument("--output")
    parser.add_argument("--expected-commit")
    parser.add_argument("--expected-lock-lf-sha")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(HelperChecks)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    for name in ("project", "output", "expected_commit", "expected_lock_lf_sha"):
        if not getattr(args, name):
            parser.error("--" + name.replace("_", "-") + " is required unless --self-test")
    try:
        return execute(args)
    except Exception as exc:
        print(Redactor(dict(os.environ))(f"Probe setup failed: {type(exc).__name__}: {exc}"),
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
