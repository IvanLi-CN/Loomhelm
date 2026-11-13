import hashlib
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from release import (
    PACKAGE_NAME,
    CANONICAL_TARBALL_DIGEST_ALGORITHM,
    LEGACY_CANONICAL_TARBALL_DIGEST_ALGORITHM,
    ReleaseError,
    Version,
    canonical_tarball_digest,
    tarball_integrity,
    dist_tag_action,
    evaluate_gate,
    identity_digest,
    load_projection,
    parse_compatibility,
    validate_tarball,
    _event_metadata,
)


ROOT_FILES = {
    "clients/typescript/package.json": {
        "name": "@loomhelm/multi-task-flow",
        "version": "0.1.0",
        "loomhelm": {
            "compatibilityLine": "compat-v1",
            "skillVersion": "2.7.2",
            "contracts": {"ledger": 2, "api": 1, "frontend": 1, "viewer": 5, "service": "1"},
        },
    },
    "skills/multi-task-flow/SKILL.md": "---\nname: multi-task-flow\nversion: 2.7.2\n---\n",
    "skills/multi-task-flow/lib/contract.ts": (
        'export const CONTRACT_VERSION = 2 as const;\n'
        'export const SKILL_VERSION = "2.7.2" as const;\n'
        'export const VIEWER_CONTRACT = 5 as const;\n'
    ),
    "skills/multi-task-flow/lib/service-contract.ts": (
        "export const API_VERSION = 1;\nexport const FRONTEND_CONTRACT = 1;\n"
    ),
}

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PUBLISH_WORKFLOW = REPOSITORY_ROOT / ".github/workflows/skill-release-publish.yml"


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, text=True, capture_output=True
    ).stdout.strip()


class ReleasePolicyTests(unittest.TestCase):
    def test_semver_order_and_rejections(self):
        ordered = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ]
        self.assertEqual([version.text for version in sorted(map(Version, ordered))], ordered)
        for value in ("01.2.3", "1.2.3+build", "1.2", "v1.2.3", "1.2.3-01"):
            with self.subTest(value=value), self.assertRaises(ReleaseError):
                Version(value)
        self.assertEqual(parse_compatibility("compat-v12").number, 12)
        with self.assertRaises(ReleaseError):
            parse_compatibility("compat-v0")

    def test_projection_rejects_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, value in ROOT_FILES.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding="utf-8")
            self.assertEqual(load_projection(root).package_version, "0.1.0")
            (root / "skills/multi-task-flow/SKILL.md").write_text(
                "---\nversion: 2.7.3\n---\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(ReleaseError, "Skill version"):
                load_projection(root)

    def test_dist_tag_promotion_is_monotonic(self):
        self.assertEqual(dist_tag_action(None, "1.0.0"), "promote")
        self.assertEqual(dist_tag_action('"0.9.0"', "1.0.0"), "promote")
        self.assertEqual(dist_tag_action('"1.0.0"', "1.0.0"), "keep")
        with self.assertRaisesRegex(ReleaseError, "newer version"):
            dist_tag_action('"1.1.0"', "1.0.0")

    def test_publish_workflow_uses_npm_trusted_publishing(self):
        workflow = PUBLISH_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("id-token: write", workflow)
        self.assertNotIn("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}", workflow)
        self.assertNotIn("NPM_CONFIG_USERCONFIG", workflow)
        self.assertIn('npm publish "$tarball" --access public --tag "$COMPATIBILITY_LINE"', workflow)
        self.assertIn("npm@11.21.0", workflow)
        self.assertIn("release:skill-initial-publication", workflow)
        self.assertIn("registry_version_missing", workflow)
        self.assertIn("--reconcile-existing", workflow)
        self.assertIn("gate --help", workflow)
        self.assertIn("protected candidate merge predates reconciliation support", workflow)
        self.assertIn("https://github.com/IvanLi-CN/Loomhelm", workflow)
        self.assertEqual(workflow.count("set_package_metadata clients/typescript/package.json"), 2)
        self.assertIn(
            'set_package_metadata clients/typescript/package.json\n'
            '          set_package_metadata clients/typescript/toolkit/package.json\n'
            '          (cd clients/typescript && bun pm pack --destination "$draft_dir"',
            workflow,
        )
        self.assertIn(
            'git checkout -- clients/typescript/package.json\n'
            '          (cd clients/typescript && bun --no-install run build)\n'
            '          set_package_metadata clients/typescript/package.json\n'
            '          set_package_metadata clients/typescript/toolkit/package.json\n'
            '          (cd clients/typescript && bun pm pack --destination "$final_dir"',
            workflow,
        )
        self.assertIn('promote "$COMPATIBILITY_LINE"', workflow)
        self.assertIn("promote latest", workflow)
        self.assertIn("canonical_file_differences=", workflow)
        self.assertIn("resume_run_id", workflow)
        self.assertIn('gh run download "$RESUME_RUN_ID" --pattern "skill-release-receipt-${MERGE_SHA}-*"', workflow)
        self.assertIn("processing", workflow)
        self.assertIn("known-409", workflow)
        self.assertIn("processing-timeout", workflow)
        self.assertIn("legacy-version-absent", workflow)
        self.assertIn("0.2.7 is legacy read-only reconciliation", workflow)
        self.assertIn("identity-mismatch", workflow)
        self.assertIn("published", workflow)
        self.assertIn("completed", workflow)
        self.assertIn("registry tarball failed artifact identity validation", workflow)
        self.assertIn("legacy-exact-visible", workflow)
        self.assertIn("registry_validation_args=(--version", workflow)
        self.assertIn("steps.publish_registry.outputs.registry_state", workflow)
        self.assertLess(workflow.index("0.2.7 is legacy read-only reconciliation"), workflow.index('npm publish "$tarball"'))
        self.assertIn("if ! grep -Eiq 'E404|404|no match found|not found' \"$exact_error\"", workflow)
        self.assertEqual(workflow.count('npm publish "$tarball"'), 1)
        self.assertNotIn('npm view "$PACKAGE_NAME" "dist-tags.$tag" --json 2>/dev/null || true', workflow)
        self.assertIn("no dist-tag", workflow)
        self.assertIn("'state': 'candidate-validated'", workflow)
        self.assertIn("name: release-identity", workflow)
        self.assertLess(
            workflow.index("Publish exact package and reconcile registry identity"),
            workflow.index("Create or reconcile immutable release tag after exact identity"),
        )

    def test_release_skill_requires_strict_version_progression(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._init_repo(root)
            base = git(root, "rev-parse", "HEAD")
            package_path = root / "clients/typescript/package.json"
            package = json.loads(package_path.read_text(encoding="utf-8"))
            package["version"] = "0.2.0"
            package_path.write_text(json.dumps(package), encoding="utf-8")
            head = self._commit(root, "release candidate")
            result = evaluate_gate(root, base=base, head=head, labels=["release:skill"])
            self.assertEqual(result.decision, "release:skill")
            package["version"] = "0.1.0"
            package_path.write_text(json.dumps(package), encoding="utf-8")
            rollback = self._commit(root, "rollback candidate")
            with self.assertRaisesRegex(ReleaseError, "strictly advance"):
                evaluate_gate(root, base=head, head=rollback, labels=["release:skill"])

    def test_initial_publication_allows_unpublished_existing_projection_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._init_repo(root)
            base = git(root, "rev-parse", "HEAD")
            (root / "tools/skill-release").mkdir(parents=True, exist_ok=True)
            (root / "tools/skill-release/note.txt").write_text("initial publication", encoding="utf-8")
            head = self._commit(root, "declare initial publication")
            result = evaluate_gate(
                root,
                base=base,
                head=head,
                labels=["release:skill-initial-publication"],
                initial_publication=True,
                registry_version_missing=True,
            )
            self.assertEqual(result.decision, "release:skill-initial-publication")
            with self.assertRaisesRegex(ReleaseError, "unpublished exact registry version or explicit registry reconciliation"):
                evaluate_gate(
                    root,
                    base=base,
                    head=head,
                    labels=["release:skill-initial-publication"],
                    initial_publication=True,
                    registry_version_missing=False,
                )
            reconciled = evaluate_gate(
                root,
                base=base,
                head=head,
                labels=["release:skill-initial-publication"],
                initial_publication=True,
                registry_version_missing=False,
                reconcile_existing=True,
            )
            self.assertEqual(reconciled.decision, "release:skill-initial-publication")
            package_path = root / "clients/typescript/package.json"
            package = json.loads(package_path.read_text(encoding="utf-8"))
            package["version"] = "0.2.0"
            package_path.write_text(json.dumps(package), encoding="utf-8")
            drift = self._commit(root, "identity drift")
            with self.assertRaisesRegex(ReleaseError, "canonical identity"):
                evaluate_gate(
                    root,
                    base=base,
                    head=drift,
                    labels=["release:skill-initial-publication"],
                    initial_publication=True,
                    registry_version_missing=True,
                )

    def test_first_skill_release_may_introduce_projection_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._init_repo(root)
            package_path = root / "clients/typescript/package.json"
            package = json.loads(package_path.read_text(encoding="utf-8"))
            package.pop("loomhelm")
            package_path.write_text(json.dumps(package), encoding="utf-8")
            base = self._commit(root, "legacy package without Skill projection")
            package["loomhelm"] = ROOT_FILES["clients/typescript/package.json"]["loomhelm"]
            package_path.write_text(json.dumps(package), encoding="utf-8")
            head = self._commit(root, "establish Skill projection")
            result = evaluate_gate(root, base=base, head=head, labels=["release:skill"])
            self.assertIsNone(result.base_version)
            self.assertEqual(result.head_version, "0.1.0")

    def test_skip_requires_reason_and_cannot_drift_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._init_repo(root)
            base = git(root, "rev-parse", "HEAD")
            (root / "tools/skill-release").mkdir(parents=True)
            (root / "tools/skill-release/note.txt").write_text("docs", encoding="utf-8")
            head = self._commit(root, "non-release change")
            with self.assertRaisesRegex(ReleaseError, "explicit skip reason"):
                evaluate_gate(root, base=base, head=head, labels=["release:skip"])
            result = evaluate_gate(
                root, base=base, head=head, labels=["release:skip"], skip_reason="tracked elsewhere"
            )
            self.assertEqual(result.reason, "tracked elsewhere")
            package_path = root / "clients/typescript/package.json"
            package = json.loads(package_path.read_text(encoding="utf-8"))
            package["version"] = "0.2.0"
            package_path.write_text(json.dumps(package), encoding="utf-8")
            drift = self._commit(root, "identity drift")
            with self.assertRaisesRegex(ReleaseError, "cannot change"):
                evaluate_gate(
                    root, base=base, head=drift, labels=["release:skip"], skip_reason="tracked elsewhere"
                )

    def test_labels_are_exactly_one_release_decision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._init_repo(root)
            base = git(root, "rev-parse", "HEAD")
            (root / "tools/skill-release").mkdir(parents=True)
            (root / "tools/skill-release/change.txt").write_text("change", encoding="utf-8")
            head = self._commit(root, "release change")
            for labels in ([], ["release:skill", "release:skip"], ["release:skill-initial-publication", "release:skip"], ["release:cli"]):
                with self.subTest(labels=labels), self.assertRaises(ReleaseError):
                    evaluate_gate(root, base=base, head=head, labels=labels)

    def test_event_metadata_accepts_delivery_unit_base_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            event_path = Path(directory) / "event.json"
            event_path.write_text(
                json.dumps(
                    {
                        "pull_request": {
                            "labels": [{"name": "release:skip"}],
                            "base": {
                                "ref": "th/skill-runtime-fresh-20261111",
                                "sha": "a" * 40,
                            },
                            "head": {"ref": "th/skill-runtime-release-ci-20261111", "sha": "b" * 40},
                            "draft": False,
                            "body": "<!-- release-skip: release automation -->",
                        }
                    }
                ),
                encoding="utf-8",
            )
            metadata = _event_metadata(event_path)
            self.assertEqual(metadata["base_sha"], "a" * 40)
            self.assertEqual(metadata["head_sha"], "b" * 40)
            self.assertEqual(metadata["skip_reason"], "release automation")

    def test_tarball_digest_and_identity_are_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package_root = root / "package"
            (package_root / "toolkit/src").mkdir(parents=True)
            (package_root / "toolkit/src/runtime.ts").write_bytes(b"runtime")
            files = [{"path": "src/runtime.ts", "sha256": ""}]
            files[0]["sha256"] = __import__("hashlib").sha256(b"runtime").hexdigest()
            identity = {
                "packageName": "@loomhelm/multi-task-flow",
                "packageVersion": "0.2.0",
                "compatibilityLine": "compat-v1",
                "skillVersion": "2.7.2",
                "sourceSha": "a" * 40,
                "mergeSha": "a" * 40,
                "dirty": False,
                "contracts": {
                    "ledgerContract": 2,
                    "apiVersion": 1,
                    "frontendContract": 1,
                    "viewerContract": 5,
                    "serviceVersion": "1",
                },
                "tarballDigest": None,
                "gitTag": "multi-task-flow-v0.2.0",
            }
            identity["buildId"] = identity_digest(identity, files)
            artifact = {
                "schemaVersion": 2,
                "packageName": identity["packageName"],
                "packageVersion": identity["packageVersion"],
                "compatibilityLine": identity["compatibilityLine"],
                "skillVersion": identity["skillVersion"],
                "sourceSha": identity["sourceSha"],
                "mergeSha": identity["mergeSha"],
                "candidateSha": identity["sourceSha"],
                "dirty": False,
                "runtime": "bun@1.4.4",
                "identity": identity,
                "buildId": identity["buildId"],
                "tarballDigest": None,
                "gitTag": identity["gitTag"],
                "files": files,
                "dependenciesBundled": True,
                "dependencies": [{"name": "zod", "version": "4.6.7", "path": "node_modules/zod", "entry": "index.js"}],
            }
            (package_root / "package.json").write_text(
                json.dumps({"name": PACKAGE_NAME, "version": "0.2.0"}), encoding="utf-8"
            )
            artifact_bytes = json.dumps(artifact, separators=(",", ":")).encode("utf-8")
            (package_root / "toolkit/artifact-manifest.json").write_bytes(artifact_bytes)
            tarball = root / "package.tgz"
            with tarfile.open(tarball, "w:gz") as archive:
                archive.add(package_root, arcname="package")
            digest = canonical_tarball_digest(tarball)
            identity["tarballDigest"] = digest
            identity["buildId"] = identity_digest(identity, files)
            artifact["tarballDigest"] = digest
            artifact["buildId"] = identity["buildId"]
            artifact["identity"] = identity
            artifact_bytes = json.dumps(artifact, separators=(",", ":")).encode("utf-8")
            (package_root / "toolkit/artifact-manifest.json").write_bytes(artifact_bytes)
            with tarfile.open(tarball, "w:gz") as archive:
                archive.add(package_root, arcname="package")
            validated = validate_tarball(
                tarball,
                expected_version="0.2.0",
                expected_merge_sha="a" * 40,
                expected_compatibility="compat-v1",
            )
            self.assertEqual(validated["tarballDigest"], digest)
            self.assertFalse(validated["canonicalDigestVerified"])
            self.assertEqual(validated["canonicalDigestAlgorithm"], LEGACY_CANONICAL_TARBALL_DIGEST_ALGORITHM)
            self.assertEqual(validated["rawIntegrity"], tarball_integrity(tarball))

    def test_path_byte_digest_is_stable_for_non_ascii_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package_root = root / "package"
            (package_root / "toolkit").mkdir(parents=True)
            (package_root / "package.json").write_text(json.dumps({"name": PACKAGE_NAME, "version": "0.2.0"}), encoding="utf-8")
            (package_root / "toolkit/z.txt").write_bytes(b"z")
            (package_root / "toolkit/é.txt").write_bytes(b"e-acute")
            tarball = root / "paths.tgz"
            with tarfile.open(tarball, "w:gz") as archive:
                archive.add(package_root, arcname="package")
            expected = hashlib.sha256()
            for path, contents in (("package.json", package_root.joinpath("package.json").read_bytes()), ("toolkit/z.txt", b"z"), ("toolkit/é.txt", b"e-acute")):
                expected.update(path.encode("utf-8"))
                expected.update(b"\0")
                expected.update(contents)
                expected.update(b"\0")
            self.assertEqual(canonical_tarball_digest(tarball), expected.hexdigest())

    def test_schema3_uses_consumer_dependencies_and_rejects_node_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package_root = root / "package"
            (package_root / "toolkit/src").mkdir(parents=True)
            (package_root / "toolkit/src/runtime.ts").write_bytes(b"runtime")
            files = [{"path": "src/runtime.ts", "sha256": hashlib.sha256(b"runtime").hexdigest()}]
            identity = {
                "packageName": PACKAGE_NAME,
                "packageVersion": "0.2.0",
                "compatibilityLine": "compat-v1",
                "skillVersion": "2.7.2",
                "sourceSha": "a" * 40,
                "mergeSha": "a" * 40,
                "dirty": False,
                "contracts": {"ledgerContract": 2, "apiVersion": 1, "frontendContract": 1, "viewerContract": 5, "serviceVersion": "1"},
                "tarballDigest": None,
                "gitTag": "multi-task-flow-v0.2.0",
                "canonicalDigestAlgorithm": CANONICAL_TARBALL_DIGEST_ALGORITHM,
            }
            identity["buildId"] = identity_digest(identity, files)
            artifact = {
                "schemaVersion": 3,
                "packageName": PACKAGE_NAME,
                "packageVersion": "0.2.0",
                "compatibilityLine": "compat-v1",
                "skillVersion": "2.7.2",
                "sourceSha": identity["sourceSha"],
                "mergeSha": identity["mergeSha"],
                "candidateSha": identity["sourceSha"],
                "dirty": False,
                "runtime": "bun@1.4.4",
                "identity": identity,
                "buildId": identity["buildId"],
                "tarballDigest": None,
                "gitTag": identity["gitTag"],
                "canonicalDigestAlgorithm": CANONICAL_TARBALL_DIGEST_ALGORITHM,
                "dependenciesBundled": False,
                "dependencies": [{"name": "zod", "version": "4.6.7", "mode": "consumer-install"}],
                "files": files,
            }
            (package_root / "package.json").write_text(json.dumps({"name": PACKAGE_NAME, "version": "0.2.0"}), encoding="utf-8")
            (package_root / "toolkit/artifact-manifest.json").write_text(json.dumps(artifact), encoding="utf-8")
            tarball = root / "schema3.tgz"
            with tarfile.open(tarball, "w:gz") as archive:
                archive.add(package_root, arcname="package")
            digest = canonical_tarball_digest(tarball)
            identity["tarballDigest"] = digest
            identity["buildId"] = identity_digest(identity, files)
            artifact["tarballDigest"] = digest
            artifact["buildId"] = identity["buildId"]
            artifact["identity"] = identity
            (package_root / "toolkit/artifact-manifest.json").write_text(json.dumps(artifact), encoding="utf-8")
            with tarfile.open(tarball, "w:gz") as archive:
                archive.add(package_root, arcname="package")
            validated = validate_tarball(tarball, expected_version="0.2.0", expected_merge_sha="a" * 40, expected_compatibility="compat-v1")
            self.assertTrue(validated["canonicalDigestVerified"])
            self.assertEqual(validated["canonicalDigestAlgorithm"], CANONICAL_TARBALL_DIGEST_ALGORITHM)
            (package_root / "toolkit/node_modules").mkdir()
            (package_root / "toolkit/node_modules/rogue.js").write_text("rogue", encoding="utf-8")
            with tarfile.open(tarball, "w:gz") as archive:
                archive.add(package_root, arcname="package")
            with self.assertRaisesRegex(ReleaseError, "node_modules"):
                validate_tarball(tarball, expected_version="0.2.0", expected_merge_sha="a" * 40, expected_compatibility="compat-v1")

    def _init_repo(self, root: Path) -> None:
        git(root, "init", "-q")
        git(root, "config", "user.email", "test@example.invalid")
        git(root, "config", "user.name", "Release Tests")
        for name, value in ROOT_FILES.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding="utf-8")
        self._commit(root, "baseline")

    def _commit(self, root: Path, message: str) -> str:
        git(root, "add", ".")
        git(root, "commit", "-q", "-m", message)
        return git(root, "rev-parse", "HEAD")


if __name__ == "__main__":
    unittest.main()
