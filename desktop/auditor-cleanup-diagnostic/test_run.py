"""Pure source-generation checks; does not import app or launch any processes."""
import importlib.util
from pathlib import Path
import unittest
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("auditor_diagnostic", Path(__file__).with_name("run.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InstrumentationTests(unittest.TestCase):
    def setUp(self):
        self.helper = MODULE.load_helper(ROOT)
        self.source = (ROOT / self.helper.HARNESS_RELATIVE).read_text(encoding="utf-8-sig")

    def test_trace_precedes_first_application_stage_and_keeps_failure(self):
        result = MODULE.instrument(self.helper, self.source)
        self.assertLess(result.index("function Write-CleanupDiagnostic("), result.index("Write-CleanupDiagnostic 'entry'"))
        self.assertLess(result.index("Write-CleanupDiagnostic 'entry'"), result.index("Add-Type -AssemblyName System.Net.Http"))
        self.assertIn("sequence = $script:cleanupDiagnosticSequence", result)
        self.assertEqual(result.count("throw 'Forced browser auditor startup cleanup failure.'"), 1)
        for stage in ("auditor.forced_failure", "auditor_launch.begin", "auditor_launch.end", "isolated_python.begin", "isolated_python.end", "cim.begin", "finally.enter", "temp-data.end"):
            self.assertIn(stage, result)
        self.assertIn("browser.root' $process.Id 'dedicated browser'", result)
        self.assertNotIn("python.root' $process.Id 'forced chromium startup'", result)
        for stage in ("browser_launch.begin", "browser_launch.end", "browser_handle.begin", "browser_handle.end", "trace.truncated"):
            self.assertIn(stage, result)
        self.assertIn("$recordBytes -gt 16384", result)
        self.assertIn("$script:cleanupDiagnosticSequence -gt 2000", result)
        self.assertIn("-gt 1048000", result)

    def test_changed_anchor_fails_instead_of_silent_partial_instrumentation(self):
        changed = self.source.replace("      throw 'Forced browser auditor startup cleanup failure.'", "      throw 'changed'")
        with self.assertRaises(ValueError):
            MODULE.instrument(self.helper, changed)

    def test_windows_checkout_text_normalizes_anchors_without_changing_original_bytes(self):
        raw = b'\xef\xbb\xbf' + self.source.replace('\n', '\r\n').encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'harness.ps1'
            path.write_bytes(raw)
            with self.assertRaises(ValueError):
                MODULE.instrument(self.helper, raw.decode('utf-8-sig'))
            result = MODULE.instrument(self.helper, path.read_text(encoding='utf-8-sig'))
            self.assertIn("Write-CleanupDiagnostic 'auditor.forced_failure'", result)
            self.assertEqual(path.read_bytes(), raw)

    def test_scope_stays_exact_original_node_with_original_timeout(self):
        self.assertTrue(MODULE.NODE.endswith("::test_story_browser_harness_cleans_all_local_resources_when_auditor_startup_fails"))
        test_source = (ROOT / "tests/test_interview_story_browser_harness.py").read_text()
        self.assertIn("_HARNESS_TIMEOUT_SECONDS = 180", test_source)
        workflow = (ROOT / ".github/workflows/auditor-cleanup-diagnostic.yml").read_text()
        self.assertIn("branches: [test/20261013-auditor-cleanup-diagnostic]", workflow)
        self.assertIn("timeout-minutes: 12", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertEqual(len(MODULE.ALLOWED), 3)

    def test_guard_requires_every_completed_root_with_only_auditor_optional(self):
        labels = ["provider proxy", "isolated service", "isolated python story-context-seed",
                  "isolated python forbidden-domain-snapshot", "browser auditor"]
        trace = [{"stage": "python.root", "label": label, "target_id": (index + 1) * 10,
                  "powershell_pid": 90} for index, label in enumerate(labels)]
        records = [{"pid": 2, "ppid": 1}] + [{"pid": root + 1, "ppid": root} for root in (10, 20, 30, 40)]
        result = {"pid": 1, "ppid": 99}
        self.assertEqual(MODULE.verify_guard_coverage(records, trace, result),
                         {"required_five_roots_verified": True, "auditor_observed": False})
        self.assertTrue(MODULE.verify_guard_coverage(records + [{"pid": 51, "ppid": 50}], trace, result)["auditor_observed"])
        for bad in (records[:1], records[:-1], records + [{"pid": 88, "ppid": 87}], records + [records[0]]):
            with self.assertRaises(ValueError):
                MODULE.verify_guard_coverage(bad, trace, result)
        with self.assertRaises(ValueError):
            MODULE.verify_guard_coverage(records, trace + [trace[0]], result)


if __name__ == "__main__":
    unittest.main()
