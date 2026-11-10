import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import compatibility
from policy import ReleaseError


def write_repo(root, skill="2.4.0", cli="0.1.0", contract=2, viewer=2):
    (root / "skills/multi-task-flow").mkdir(parents=True)
    (root / "clients/typescript").mkdir(parents=True)
    (root / "skills/multi-task-flow/SKILL.md").write_text(f"---\nversion: {skill}\n---\n")
    (root / "clients/typescript/package.json").write_text(json.dumps({"name": "@loomhelm/client", "version": cli}))
    (root / "skills/multi-task-flow/lib").mkdir()
    (root / "skills/multi-task-flow/lib/contract.ts").write_text(
        f'export const CONTRACT_VERSION = {contract};\nexport const VIEWER_CONTRACT = {viewer};\nexport const SKILL_VERSION = "{skill}";\n'
    )


class CompatibilityTests(unittest.TestCase):
    def test_required_labels_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            write_repo(root)
            (root / "skills/multi-task-flow/lib/engine.ts").write_text("old")
            base = "base"
            head = "head"
            with patch.object(compatibility, "ROOT", root), patch.object(compatibility, "git_files", return_value=["skills/multi-task-flow/lib/engine.ts", "clients/typescript/src/cli.ts", "skills/multi-task-flow/lib/schema.ts"]), patch.object(compatibility, "read_at") as read:
                values = {
                    (base, "skills/multi-task-flow/SKILL.md"): "version: 2.4.0\n",
                    (head, "skills/multi-task-flow/SKILL.md"): "version: 2.5.0\n",
                    (base, "clients/typescript/package.json"): '{"version":"0.1.0"}',
                    (head, "clients/typescript/package.json"): '{"version":"0.2.0"}',
                    (base, "skills/multi-task-flow/lib/contract.ts"): 'export const CONTRACT_VERSION = 2; export const VIEWER_CONTRACT = 2; export const SKILL_VERSION = "2.4.0";',
                    (head, "skills/multi-task-flow/lib/contract.ts"): 'export const CONTRACT_VERSION = 3; export const VIEWER_CONTRACT = 3; export const SKILL_VERSION = "2.5.0";',
                }
                read.side_effect = lambda ref, path: values.get((ref, path))
                with patch.object(compatibility, "git", side_effect=lambda *args, **kwargs: {("rev-parse", base): "a" * 40 + "\n", ("rev-parse", head): "b" * 40 + "\n"}.get(args, "")):
                    result = compatibility.check(base, head, {"release:skill", "release:cli", "release:contract", "release:viewer"})
            self.assertEqual(result["dist_tag"], "compat-v3")
            self.assertEqual(result["cli_version"], "0.2.0")

    def test_missing_label_fails_closed(self):
        with patch.object(compatibility, "git_files", return_value=["clients/typescript/src/cli.ts"]):
            with self.assertRaisesRegex(ReleaseError, "missing release label"):
                compatibility.check("base", "head", set())

    def test_version_must_advance(self):
        with patch.object(compatibility, "git_files", return_value=["clients/typescript/src/cli.ts"]), patch.object(compatibility, "cli_version", side_effect=["0.1.0", "0.1.0"]):
            with self.assertRaisesRegex(ReleaseError, "must advance"):
                compatibility.check("base", "head", {"release:cli"})

    def test_skill_version_only_change_does_not_require_contract_label(self):
        files = ["skills/multi-task-flow/SKILL.md", "skills/multi-task-flow/lib/contract.ts"]
        values = {
            ("base", "skills/multi-task-flow/SKILL.md"): "version: 2.4.0\n",
            ("head", "skills/multi-task-flow/SKILL.md"): "version: 2.5.0\n",
            ("base", "skills/multi-task-flow/lib/contract.ts"): 'export const CONTRACT_VERSION = 2; export const VIEWER_CONTRACT = 2; export const SKILL_VERSION = "2.4.0";\n',
            ("head", "skills/multi-task-flow/lib/contract.ts"): 'export const CONTRACT_VERSION = 2; export const VIEWER_CONTRACT = 2; export const SKILL_VERSION = "2.5.0";\n',
        }
        with patch.object(compatibility, "git_files", return_value=files), patch.object(compatibility, "read_at", side_effect=lambda ref, path: values.get((ref, path))), patch.object(
            compatibility,
            "git",
            side_effect=lambda *args, **kwargs: {("rev-parse", "base"): "a" * 40 + "\n", ("rev-parse", "head"): "b" * 40 + "\n"}.get(args, ""),
        ):
            result = compatibility.check("base", "head", {"release:skill"})
        self.assertEqual(result["required_labels"], ["release:skill"])
        self.assertEqual(result["skill_version"], "2.5.0")

    def test_viewer_marker_does_not_change_ledger_contract(self):
        path = "skills/multi-task-flow/lib/contract.ts"
        before = 'export const CONTRACT_VERSION = 2; export const VIEWER_CONTRACT = 3;'
        after = before.replace('VIEWER_CONTRACT = 3', 'VIEWER_CONTRACT = 4')
        with patch.object(compatibility, "read_at", side_effect=[before, after]):
            self.assertFalse(compatibility.contract_semantics_changed("base", "head", [path]))
        with patch.object(compatibility, "read_at", side_effect=[before, after + '\nexport const changed = true;']):
            self.assertTrue(compatibility.contract_semantics_changed("base", "head", [path]))

    def test_private_package_cannot_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text('{"name":"private","version":"1.0.0","private":true}')
            with patch.object(compatibility, "ROOT", root), self.assertRaisesRegex(ReleaseError, "private package"):
                compatibility.publish(root, "compat-v2", dry_run=True)


if __name__ == "__main__":
    unittest.main()
