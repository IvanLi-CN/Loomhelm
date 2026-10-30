#!/usr/bin/env python3

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name("v01_acceptance.py")
SPEC = importlib.util.spec_from_file_location("v01_acceptance", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class V01AcceptanceTests(unittest.TestCase):
    def test_redact_removes_dsn_and_bearer_secrets(self) -> None:
        value = "postgres://loomhelm:secret@127.0.0.1:5432/loomhelm Authorization: Bearer abc.def password=hidden"
        redacted = MODULE.redact(value)
        self.assertNotIn("secret", redacted)
        self.assertNotIn("abc.def", redacted)
        self.assertNotIn("hidden", redacted)
        self.assertIn("<redacted>", redacted)

    def test_candidate_manifest_reads_v2_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "candidate-manifest.json"
            source_sha = "a" * 40
            digest = "b" * 64
            path.write_text(
                json.dumps({"candidate": {"source_sha": source_sha, "digest": digest}}),
                encoding="utf-8",
            )
            self.assertEqual(
                MODULE.candidate_manifest(path),
                {"source_sha": source_sha, "digest": digest},
            )

    def test_directory_evidence_digest_is_stable_and_counts_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "nested").mkdir()
            (root / "b.txt").write_text("b", encoding="utf-8")
            (root / "nested" / "a.txt").write_text("a", encoding="utf-8")
            first = MODULE.evidence_digest(root)
            second = MODULE.evidence_digest(root)
            self.assertEqual(first, second)
            self.assertEqual(first[1], 2)

    def test_markdown_report_exposes_historical_reuse_boundary(self) -> None:
        source_sha = "a" * 40
        ledger = {
            "source": {"sha": source_sha, "tree_sha": "c" * 40, "parent_branch": "feat/phase1", "parent_sha": source_sha},
            "candidate": {"digest": "b" * 64, "manifest_path": "/tmp/manifest.json"},
            "checks": {
                check_id: {
                    "status": "not_run",
                    "current_candidate_proof": False,
                    "attempts": [],
                    "evidence": [],
                    "decisions": [],
                }
                for check_id in MODULE.CHECKS
            },
        }
        ledger["checks"]["AC-LH-004"]["status"] = "reused"
        ledger["checks"]["AC-LH-004"]["evidence"] = [{"status": "reused", "path": "/tmp/old.json"}]
        report = MODULE.render_markdown(ledger)
        self.assertIn("`reused`", report)
        self.assertIn("A `reused` record is historical evidence", report)


if __name__ == "__main__":
    unittest.main()
