#!/usr/bin/env python3

import importlib.util
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace


sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name("v01_acceptance.py")
SPEC = importlib.util.spec_from_file_location("v01_acceptance", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class V01AcceptanceTests(unittest.TestCase):
    def test_redact_removes_dsn_and_bearer_secrets(self) -> None:
        value = (
            'postgres://loomhelm:secret@127.0.0.1:5432/loomhelm '
            'Authorization: Bearer abc.def Basic YWJjZA== '
            'ACCESS_TOKEN="json-secret" DB_PASSWORD=db-secret '
            'DATABASE_URL=postgres://user:env-secret@localhost/db '
            'https://user:url-secret@example.test/?refresh_token=query-secret'
        )
        redacted = MODULE.redact(value, ["json-secret", "db-secret", "env-secret", "query-secret"])
        for secret in ("secret", "abc.def", "YWJjZA==", "json-secret", "db-secret", "env-secret", "url-secret", "query-secret"):
            self.assertNotIn(secret, redacted)
        self.assertIn("<redacted>", redacted)

    def test_candidate_manifest_reads_v2_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "candidate-manifest.json"
            source_sha = "a" * 40
            tree_sha = "c" * 40
            digest = "b" * 64
            manifest = {
                "schema_version": 2,
                "candidate": {
                    "source_sha": source_sha,
                    "source_tree_sha": tree_sha,
                    "source_date_epoch": 0,
                    "digest": digest,
                },
                "platform": {},
                "inputs": {},
                "artifacts": {},
            }
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with mock.patch.object(MODULE, "verify_candidate_bundle", return_value=manifest):
                self.assertEqual(
                    MODULE.candidate_manifest(path),
                    {"source_sha": source_sha, "source_tree_sha": tree_sha, "digest": digest},
                )

    def test_candidate_manifest_rejects_legacy_shape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "candidate-manifest.json"
            manifest = {"source_sha": "a" * 40, "artifact_digest": "b" * 64}
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with mock.patch.object(MODULE, "verify_candidate_bundle", return_value=manifest):
                with self.assertRaises(ValueError):
                    MODULE.candidate_manifest(path)

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

    def test_run_records_source_bound_pass_without_current_candidate_proof(self) -> None:
        source_sha = "a" * 40
        tree_sha = "c" * 40
        ledger = {
            "schema_version": MODULE.SCHEMA_VERSION,
            "source": {"sha": source_sha, "tree_sha": tree_sha},
            "candidate": {},
            "attempt_sequence": 0,
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
        binding = {
            "source_sha": source_sha,
            "source_tree_sha": tree_sha,
            "candidate_digest": None,
            "candidate_verified": False,
        }
        with tempfile.TemporaryDirectory() as temporary:
            evidence_dir = Path(temporary)
            MODULE.atomic_write_json(evidence_dir / "ledger.json", ledger)
            args = SimpleNamespace(
                evidence_dir=str(evidence_dir),
                check_id="AC-LH-008",
                allow_repeat=False,
                command=["--", sys.executable, "-c", "print('ACCESS_TOKEN=run-secret')"],
                timeout="10",
                name="redaction-test",
                candidate_proof=None,
            )
            with mock.patch.object(MODULE, "validate_execution_binding", return_value=binding):
                self.assertEqual(MODULE.run_check(args), 0)
            saved = json.loads((evidence_dir / "ledger.json").read_text(encoding="utf-8"))
            attempt = saved["checks"]["AC-LH-008"]["attempts"][0]
            log = (evidence_dir / attempt["stdout_log"]).read_text(encoding="utf-8")
            self.assertEqual(attempt["execution_binding"], "source-bound")
            self.assertFalse(attempt["current_candidate_proof"])
            self.assertNotIn("run-secret", log)
            self.assertIn("<redacted>", log)

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
        ledger["checks"]["AC-LH-004"]["evidence"] = [
            {"status": "reused", "path": "/tmp/old.json", "reason": "historical only"}
        ]
        ledger["checks"]["AC-LH-008"]["status"] = "passed"
        report = MODULE.render_markdown(ledger)
        self.assertIn("`reused`", report)
        self.assertIn("A `reused` record is historical evidence", report)
        self.assertIn("historical only", report)
        self.assertIn("passed/source-bound", report)


if __name__ == "__main__":
    unittest.main()
