"""One synthetic auditor-failure node with bounded phase evidence, not a gate."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

BASE = "a1009e8064588f6f2a4bc77b29172594de968463"
NODE = "tests/test_interview_story_browser_harness.py::test_story_browser_harness_cleans_all_local_resources_when_auditor_startup_fails"
ALLOWED = {
    "desktop/auditor-cleanup-diagnostic/run.py",
    "desktop/auditor-cleanup-diagnostic/test_run.py",
    ".github/workflows/auditor-cleanup-diagnostic.yml",
}


def load_helper(repo):
    spec = importlib.util.spec_from_file_location("reviewed_cleanup", repo / "desktop/browser-cleanup-diagnostic/run.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def instrument(helper, source):
    result = helper.instrument(source)
    trace_start = result.index("function Write-CleanupDiagnostic(")
    trace_end = result.index("function Stop-Tree(", trace_start)
    trace_function = result[trace_start:trace_end]
    trace_function = helper.replace_once(trace_function, "    $record = [ordered]@{",
        "    $script:cleanupDiagnosticSequence++\n    $record = [ordered]@{\n      sequence = $script:cleanupDiagnosticSequence")
    trace_function = helper.replace_once(trace_function, "  try {\n", "  if ($script:cleanupDiagnosticTruncated) { return }\n  try {\n")
    trace_function = helper.replace_once(trace_function,
        "    [IO.File]::AppendAllText($env:STORY_CLEANUP_TRACE, $record + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))",
        "    $currentBytes = if (Test-Path -LiteralPath $env:STORY_CLEANUP_TRACE) { (Get-Item -LiteralPath $env:STORY_CLEANUP_TRACE).Length } else { 0 }\n"
        "    $recordBytes = [Text.Encoding]::UTF8.GetByteCount($record)\n"
        "    if ($script:cleanupDiagnosticSequence -gt 2000 -or $recordBytes -gt 16384 -or ($currentBytes + $recordBytes + 2) -gt 1048000) {\n"
        "      $script:cleanupDiagnosticTruncated = $true\n"
        "      [IO.File]::AppendAllText($env:STORY_CLEANUP_TRACE, '{\"stage\":\"trace.truncated\"}' + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))\n"
        "      return\n"
        "    }\n"
        "    [IO.File]::AppendAllText($env:STORY_CLEANUP_TRACE, $record + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))")
    result = result[:trace_start] + result[trace_end:]
    result = helper.replace_once(result, "Add-Type -AssemblyName System.Net.Http",
        "$script:cleanupDiagnosticSequence = 0\n$script:cleanupDiagnosticTruncated = $false\n" + trace_function
        + "Write-CleanupDiagnostic 'entry'\nWrite-CleanupDiagnostic 'http_type.begin'\n"
        + "Add-Type -AssemblyName System.Net.Http\nWrite-CleanupDiagnostic 'http_type.end'")
    # The old probe only ran a forced Python Chromium stub. This node launches
    # actual Chromium; do not falsely label it as a guarded Python process.
    result = helper.replace_once(result,
        "  Write-CleanupDiagnostic 'python.root' $process.Id 'forced chromium startup' @{ executable = $projectPython }",
        "  Write-CleanupDiagnostic 'browser.root' $process.Id 'dedicated browser' @{ executable = $chromium }")
    for name, statement in (
        ("isolated_python", "    $process = Start-Process -FilePath $projectPython -WorkingDirectory $repo -ArgumentList @($scriptPath) -PassThru -Wait -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath"),
        ("proxy_launch", "  $proxy = Start-Process -FilePath $projectPython -WorkingDirectory $repo -WindowStyle Hidden -PassThru -ArgumentList @('scripts/provider-egress-proxy.py', '--port', $proxyPort, '--audit', $providerAudit, '--expected-endpoints-file', $providerAllowlist)"),
        ("service_launch", "  $server = Start-Process -FilePath $projectOc -WorkingDirectory $repo -WindowStyle Hidden -PassThru -ArgumentList @('start', '--port', $port)"),
        ("auditor_launch", "    $process = Start-Process -FilePath $projectPython -WorkingDirectory $repo -WindowStyle Hidden -PassThru -ArgumentList @('scripts/browser-network-audit.py', '--debugging-url', $cdpUrl, '--expected-url', $expectedUrl, '--audit', $browserAudit, '--stop-file', $browserStop, '--ready-file', $browserReady) -RedirectStandardOutput $auditorStdout -RedirectStandardError $auditorStderr"),
    ):
        result = helper.replace_once(result, statement,
            f"  Write-CleanupDiagnostic '{name}.begin'\n{statement}\n  Write-CleanupDiagnostic '{name}.end'")
    result = helper.replace_once(result, "    $trackedAuditor.Value = $process",
        "    $trackedAuditor.Value = $process\n    Write-CleanupDiagnostic 'python.root' $process.Id 'browser auditor' @{ executable = $projectPython }")
    result = helper.replace_once(result, "      throw 'Forced browser auditor startup cleanup failure.'",
        "      Write-CleanupDiagnostic 'auditor.forced_failure' $process.Id 'browser auditor'\n      throw 'Forced browser auditor startup cleanup failure.'")
    launch_start = result.index("        $process = Start-Process -FilePath $chromium -PassThru -ArgumentList @(")
    launch_end_marker = "        ) -RedirectStandardOutput $attemptStdout -RedirectStandardError $attemptStderr"
    launch_end = result.index(launch_end_marker, launch_start) + len(launch_end_marker)
    launch = result[launch_start:launch_end]
    result = helper.replace_once(result, launch,
        "        Write-CleanupDiagnostic 'browser_launch.begin'\n" + launch
        + "\n        Write-CleanupDiagnostic 'browser_launch.end' $process.Id 'dedicated browser'")
    result = helper.replace_once(result, "      [void]$process.Handle",
        "      Write-CleanupDiagnostic 'browser_handle.begin' $process.Id 'dedicated browser'\n"
        "      [void]$process.Handle\n      Write-CleanupDiagnostic 'browser_handle.end' $process.Id 'dedicated browser'")
    return result


def verify_guard_coverage(records, trace, result):
    launches = [row for row in trace if row["stage"] == "python.root"]
    labels = {
        "provider proxy", "isolated service", "isolated python story-context-seed",
        "isolated python forbidden-domain-snapshot", "browser auditor",
    }
    if len(launches) != 5 or {row["label"] for row in launches} != labels:
        raise ValueError("Missing or duplicate owned Python launch roots")
    roots = [("pytest", result["pid"])] + [(row["label"], row["target_id"]) for row in launches]
    if len({pid for _, pid in roots}) != 6 or any(type(pid) is not int or pid <= 0 for _, pid in roots):
        raise ValueError("Invalid or duplicate owned root PID")
    parents = {}
    def add(pid, ppid):
        if any(type(value) is not int or value <= 0 for value in (pid, ppid)) or pid == ppid:
            raise ValueError("Invalid process identity")
        if pid in parents and parents[pid] != ppid:
            raise ValueError("Conflicting process parent identity")
        parents[pid] = ppid
    add(result["pid"], result["ppid"])
    for row in launches:
        add(row["target_id"], row["powershell_pid"])
    for event in trace:
        if event["stage"].startswith("cim.end"):
            for child in event["details"] or []:
                if child["ParentProcessId"] != event["target_id"]:
                    raise ValueError("CIM child has inconsistent parent identity")
                add(child["ProcessId"], child["ParentProcessId"])
    for record in records:
        add(record["pid"], record["ppid"])
    for pid in parents:
        visited = set()
        while pid in parents:
            if pid in visited:
                raise ValueError("Process parent cycle")
            visited.add(pid)
            pid = parents[pid]
    if len({record["pid"] for record in records}) != len(records):
        raise ValueError("Duplicate guard PID")
    covered = set()
    auditor_observed = False
    for label, root in roots:
        matches = set()
        for record in records:
            pid = record["pid"]
            while True:
                if pid == root:
                    matches.add(record["pid"])
                    break
                if pid not in parents:
                    break
                pid = parents[pid]
        if not matches and label == "browser auditor":
            continue
        if len(matches) != 1 or covered & matches:
            raise ValueError(f"Missing or ambiguous guard coverage for {label}")
        covered.update(matches)
        if label == "browser auditor":
            auditor_observed = True
    if covered != {record["pid"] for record in records}:
        raise ValueError("Guard record outside owned roots")
    return {"required_five_roots_verified": True, "auditor_observed": auditor_observed}


def main():
    if os.name != "nt":
        raise RuntimeError("Native diagnostic requires Windows")
    repo = Path(__file__).resolve().parents[2]
    def git(*args):
        return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    changed = set(git("diff", "--no-renames", "--name-only", BASE, "HEAD").splitlines())
    if not changed or changed - ALLOWED or git("status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError("Only the reviewed diagnostic files may differ from a100")
    helper = load_helper(repo)
    helper.NODE_ID = NODE
    evidence = repo / "desktop/auditor-cleanup-diagnostic/evidence"
    evidence.mkdir(exist_ok=False)
    original = repo / helper.HARNESS_RELATIVE
    before = original.read_bytes()
    instrumented = instrument(helper, before.decode("utf-8-sig"))
    temporary = original.with_name(f".auditor-cleanup-diagnostic-{uuid.uuid4().hex}.ps1")
    result = None
    guard_coverage = None
    errors = []
    try:
        temporary.write_text(instrumented, encoding="utf-8-sig")
        env = helper.prepare_offline_environment(repo, evidence, temporary)
        result = helper.bounded_run([
            str(repo / ".venv/Scripts/python.exe"), "-m", "pytest", "-p", "story_cleanup_probe_plugin",
            "-v", "-s", NODE, "--basetemp", str(evidence / "pytest-temp"),
            "--junitxml", str(evidence / "node.xml"),
        ], cwd=repo, env=env, evidence=evidence, name="node", timeout=240)
    finally:
        temporary.unlink(missing_ok=True)
        if original.read_bytes() != before:
            errors.append("Original harness changed")
        try:
            trace = [json.loads(line) for line in (evidence / "harness-cleanup.jsonl").read_text().splitlines()]
            stages = {row["stage"] for row in trace}
            if "trace.truncated" in stages:
                errors.append("Phase evidence exceeded its bounded capture limit")
            sequence = [row.get("sequence") for row in trace if row["stage"] != "trace.truncated"]
            if any(type(value) is not int for value in sequence) or sequence != list(range(1, len(sequence) + 1)):
                errors.append("Phase evidence has missing or duplicate sequence numbers")
            if not {"harness.begin", "auditor.forced_failure", "finally.exit failures=0"} <= stages:
                errors.append("Expected auditor failure and complete cleanup phases not observed")
            guards = helper.read_guard_records(evidence)
            guard_coverage = verify_guard_coverage(guards, trace, result)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            guards = []
            errors.append(f"Incomplete phase/guard evidence: {type(exc).__name__}")
        report = {
            "base": BASE, "source": git("rev-parse", "HEAD"), "node": NODE,
            "harness_sha256": hashlib.sha256(before).hexdigest(),
            "instrumented_sha256": hashlib.sha256(instrumented.encode("utf-8-sig")).hexdigest(),
            "result": result, "evidence_errors": errors, "guard_record_count": len(guards),
            "guard_coverage": guard_coverage,
            "scope": "diagnostic only; original180s assertion retained; no credentials or provider calls",
            "coverage_limit": "only auditor may be unobserved; no claim it loaded the guard without a verified record",
        }
        (evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
    return 0 if result and result["returncode"] == 0 and not result["timed_out"] and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
