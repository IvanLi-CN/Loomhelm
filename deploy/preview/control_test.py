import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import control


def manifest(root: Path, source: str, state_version: int = 1, read_min: int = 1, read_max: int = 1) -> dict:
    return {
        "schema_version": 1,
        "source_sha": source,
        "artifact_digest": "sha256:" + source + "0" * 24,
        "images": {
            "server": "example/server@sha256:" + source + "0" * 24,
            "worker": "example/worker@sha256:" + source + "0" * 24,
        },
        "web": {"root": str(root), "digest": control.tree_digest(root)},
        "compatibility": {"state_version": state_version, "read_min": read_min, "read_max": read_max},
    }


class PreviewControlTest(unittest.TestCase):
    def test_compose_environment_preserves_browser_auth_and_private_file_mode(self) -> None:
        required = {
            "LOOMHELM_PREVIEW_PROJECT_NAME": "preview-auth-test",
            "LOOMHELM_PREVIEW_HTTP_PORT": "18080",
            "LOOMHELM_PREVIEW_ADMIN_PORT": "12019",
            "LOOMHELM_BLUE_SERVER_PORT": "18081",
            "LOOMHELM_GREEN_SERVER_PORT": "18082",
            "LOOMHELM_DATABASE_URL": "postgres://fixture:fixture@db/loomhelm",
            "LOOMHELM_DRAIN_TOKEN": "fixture-drain-token",
        }
        configured = {
            "LOOMHELM_OIDC_ISSUER_URL": "https://issuer.example.test",
            "LOOMHELM_OIDC_CLIENT_ID": "preview-client",
            "LOOMHELM_OIDC_CLIENT_SECRET": "fixture-client-secret",
            "LOOMHELM_OIDC_REDIRECT_URL": "https://preview.example.test/api/v1/auth/oidc/callback",
        }
        for name, auth in (("disabled", {}), ("configured", configured), ("isolated-http", {**configured, "LOOMHELM_SESSION_COOKIE_SECURE": "false"})):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as raw_dir, patch.dict(os.environ, {**required, **auth}, clear=True):
                state_dir = Path(raw_dir) / "state"
                output = state_dir / "compose.env"
                captured = io.StringIO()
                with redirect_stdout(captured):
                    self.invoke("init", state_dir)
                    self.invoke("compose_env", state_dir, output=output)
                actual = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines())
                for key in configured:
                    self.assertEqual(actual[key], auth.get(key, ""))
                self.assertEqual(actual["LOOMHELM_SESSION_COOKIE_SECURE"], auth.get("LOOMHELM_SESSION_COOKIE_SECURE", "true"))
                self.assertEqual(actual["LOOMHELM_STOP_GRACE_PERIOD"], "110s")
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
                self.assertNotIn(required["LOOMHELM_DRAIN_TOKEN"], captured.getvalue())
                self.assertNotIn(configured["LOOMHELM_OIDC_CLIENT_SECRET"], captured.getvalue())
                with patch.dict(os.environ, {**required, "LOOMHELM_PREVIEW_PROJECT_NAME": "renamed-preview"}, clear=True):
                    self.invoke("compose_env", state_dir, output=output)
                renamed = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines())
                self.assertEqual(renamed["LOOMHELM_ARTIFACT_VOLUME_NAME"], actual["LOOMHELM_ARTIFACT_VOLUME_NAME"])

    def test_compose_project_name_cannot_change_after_activation(self) -> None:
        settings = {
            "LOOMHELM_PREVIEW_PROJECT_NAME": "preview-project-lock-test",
            "LOOMHELM_PREVIEW_HTTP_PORT": "18080",
            "LOOMHELM_PREVIEW_ADMIN_PORT": "12019",
            "LOOMHELM_BLUE_SERVER_PORT": "18081",
            "LOOMHELM_GREEN_SERVER_PORT": "18082",
            "LOOMHELM_DATABASE_URL": "postgres://fixture:fixture@db/loomhelm",
            "LOOMHELM_DRAIN_TOKEN": "fixture-drain-token",
        }
        with tempfile.TemporaryDirectory() as raw_dir, patch.dict(os.environ, settings, clear=True):
            state_dir = Path(raw_dir) / "state"
            self.invoke("init", state_dir)
            self.invoke("compose_env", state_dir, output=state_dir / "compose.env")
            state = control.load_state(state_dir)
            state["active_slot"] = "blue"
            control.write_state(state_dir, state)
            with patch.dict(os.environ, {**settings, "LOOMHELM_PREVIEW_PROJECT_NAME": "renamed-preview"}, clear=True):
                with self.assertRaises(control.ContractError):
                    self.invoke("validate_project", state_dir)
                with self.assertRaises(control.ContractError):
                    self.invoke("compose_env", state_dir, output=state_dir / "compose.env")

    def test_legacy_active_state_cannot_be_rebound_to_a_new_project(self) -> None:
        settings = {
            "LOOMHELM_PREVIEW_PROJECT_NAME": "preview-legacy-project",
            "LOOMHELM_PREVIEW_HTTP_PORT": "18080",
            "LOOMHELM_PREVIEW_ADMIN_PORT": "12019",
            "LOOMHELM_BLUE_SERVER_PORT": "18081",
            "LOOMHELM_GREEN_SERVER_PORT": "18082",
            "LOOMHELM_DATABASE_URL": "postgres://fixture:fixture@db/loomhelm",
            "LOOMHELM_DRAIN_TOKEN": "fixture-drain-token",
        }
        with tempfile.TemporaryDirectory() as raw_dir, patch.dict(os.environ, settings, clear=True):
            state_dir = Path(raw_dir) / "state"
            self.invoke("init", state_dir)
            self.invoke("compose_env", state_dir, output=state_dir / "compose.env")
            state = control.load_state(state_dir)
            state.pop("compose_project_name", None)
            state["active_slot"] = "blue"
            control.write_state(state_dir, state)
            with patch.dict(os.environ, {**settings, "LOOMHELM_PREVIEW_PROJECT_NAME": "renamed-preview"}, clear=True):
                with self.assertRaises(control.ContractError):
                    self.invoke("compose_env", state_dir, output=state_dir / "compose.env")

    def test_compose_grace_covers_a_longer_shutdown_timeout(self) -> None:
        self.assertEqual(control.default_stop_grace_period("1m30s"), "300s")
        settings = {
            "LOOMHELM_PREVIEW_PROJECT_NAME": "preview-grace-test",
            "LOOMHELM_PREVIEW_HTTP_PORT": "18080",
            "LOOMHELM_PREVIEW_ADMIN_PORT": "12019",
            "LOOMHELM_BLUE_SERVER_PORT": "18081",
            "LOOMHELM_GREEN_SERVER_PORT": "18082",
            "LOOMHELM_DATABASE_URL": "postgres://fixture:fixture@db/loomhelm",
            "LOOMHELM_DRAIN_TOKEN": "fixture-drain-token",
            "LOOMHELM_SHUTDOWN_TIMEOUT": "120s",
            "LOOMHELM_STOP_GRACE_PERIOD": "5s",
        }
        with tempfile.TemporaryDirectory() as raw_dir, patch.dict(os.environ, settings, clear=True):
            state_dir = Path(raw_dir) / "state"
            output = state_dir / "compose.env"
            self.invoke("init", state_dir)
            self.invoke("compose_env", state_dir, output=output)
            actual = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines())
            self.assertEqual(actual["LOOMHELM_SHUTDOWN_TIMEOUT"], "120s")
            self.assertEqual(actual["LOOMHELM_STOP_GRACE_PERIOD"], "390s")

    def test_compose_environment_rejects_invalid_shutdown_and_grace_durations(self) -> None:
        required = {
            "LOOMHELM_PREVIEW_PROJECT_NAME": "preview-invalid-duration-test",
            "LOOMHELM_PREVIEW_HTTP_PORT": "18080",
            "LOOMHELM_PREVIEW_ADMIN_PORT": "12019",
            "LOOMHELM_BLUE_SERVER_PORT": "18081",
            "LOOMHELM_GREEN_SERVER_PORT": "18082",
            "LOOMHELM_DATABASE_URL": "postgres://fixture:fixture@db/loomhelm",
            "LOOMHELM_DRAIN_TOKEN": "fixture-drain-token",
        }
        for name, invalid in (("LOOMHELM_SHUTDOWN_TIMEOUT", "not-a-duration"), ("LOOMHELM_STOP_GRACE_PERIOD", "0s"), ("LOOMHELM_STOP_GRACE_PERIOD", "0.1ns")):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as raw_dir, patch.dict(os.environ, {**required, name: invalid}, clear=True):
                state_dir = Path(raw_dir) / "state"
                self.invoke("init", state_dir)
                with self.assertRaises(control.ContractError):
                    self.invoke("compose_env", state_dir, output=state_dir / "compose.env")

    def test_failed_compose_environment_does_not_persist_derived_state(self) -> None:
        settings = {
            "LOOMHELM_PREVIEW_PROJECT_NAME": "preview-atomic-state-test",
            "LOOMHELM_PREVIEW_HTTP_PORT": "18080",
            "LOOMHELM_PREVIEW_ADMIN_PORT": "12019",
            "LOOMHELM_BLUE_SERVER_PORT": "18081",
            "LOOMHELM_GREEN_SERVER_PORT": "18082",
        }
        with tempfile.TemporaryDirectory() as raw_dir, patch.dict(os.environ, settings, clear=True):
            state_dir = Path(raw_dir) / "state"
            output = state_dir / "compose.env"
            self.invoke("init", state_dir)
            with self.assertRaises(control.ContractError):
                self.invoke("compose_env", state_dir, output=output)
            state = control.load_state(state_dir)
            self.assertIsNone(state["compose_project_name"])
            self.assertIsNone(state["artifact_volume_name"])
            self.assertFalse(output.exists())

    def write_manifest(self, path: Path, value: dict) -> None:
        path.write_text(json.dumps(value), encoding="utf-8")

    def invoke(self, name: str, state_dir: Path, **values: str) -> None:
        options = {"state_dir": state_dir, "manifest": None, "slot": None, "output": None, "field": None, "retained_key": None, "reason": "test"}
        options.update(values)
        args = Namespace(**options)
        getattr(control, f"command_{name.replace('-', '_')}")(args)

    def start_lock_holder(self, state_dir: Path, ready: Path, release: Path, *, workflow: bool) -> subprocess.Popen:
        source = """
from pathlib import Path
import sys
import time

import control

state_dir = Path(sys.argv[1])
ready = Path(sys.argv[2])
release = Path(sys.argv[3])
with control.state_lock(state_dir):
    ready.write_text('locked', encoding='utf-8')
    while not release.exists():
        time.sleep(0.01)
"""
        environment = os.environ.copy()
        module_dir = str(Path(control.__file__).resolve().parent)
        environment["PYTHONPATH"] = os.pathsep.join(filter(None, (module_dir, environment.get("PYTHONPATH"))))
        if workflow:
            environment.pop("LOOMHELM_PREVIEW_WORKFLOW_LOCK_HELD", None)
        else:
            environment["LOOMHELM_PREVIEW_WORKFLOW_LOCK_HELD"] = "1"
        return subprocess.Popen(
            [sys.executable, "-c", source, str(state_dir), str(ready), str(release)],
            cwd=module_dir,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def wait_for_file(self, path: Path, process: subprocess.Popen, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.exists():
                return
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                self.fail(f"lock helper exited with {process.returncode}: {stdout}{stderr}")
            time.sleep(0.01)
        self.fail(f"timed out waiting for {path}")

    def test_state_lock_serializes_processes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_dir = root / "state"
            holder_ready = root / "holder.ready"
            holder_release = root / "holder.release"
            contender_ready = root / "contender.ready"
            contender_release = root / "contender.release"
            holder = self.start_lock_holder(state_dir, holder_ready, holder_release, workflow=False)
            contender = None
            try:
                self.wait_for_file(holder_ready, holder)
                contender = self.start_lock_holder(state_dir, contender_ready, contender_release, workflow=False)
                time.sleep(0.15)
                self.assertIsNone(contender.poll(), "state lock contender acquired before the holder released it")
                self.assertFalse(contender_ready.exists())
                holder_release.touch()
                self.wait_for_file(contender_ready, contender)
                contender_release.touch()
                contender_stdout, contender_stderr = contender.communicate(timeout=5)
                self.assertEqual(contender.returncode, 0, f"state contender failed: {contender_stdout}{contender_stderr}")
            finally:
                holder_release.touch()
                if contender is not None:
                    contender_release.touch()
                    contender.communicate(timeout=5)
                holder.communicate(timeout=5)

    def test_preview_workflow_lock_serializes_wrapper_processes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_dir = root / "state"
            holder_ready = root / "holder.ready"
            holder_release = root / "holder.release"
            holder = self.start_lock_holder(state_dir, holder_ready, holder_release, workflow=True)
            contender = None
            try:
                self.wait_for_file(holder_ready, holder)
                environment = os.environ.copy()
                environment["LOOMHELM_PREVIEW_STATE_DIR"] = str(state_dir)
                contender = subprocess.Popen(
                    [str(control.ROOT / "scripts" / "preview"), "init"],
                    cwd=control.ROOT,
                    env=environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                time.sleep(0.15)
                self.assertIsNone(contender.poll(), "preview workflow acquired before the holder released it")
                self.assertFalse((state_dir / "state.json").exists())
                holder_release.touch()
                stdout, stderr = contender.communicate(timeout=5)
                self.assertEqual(contender.returncode, 0, f"preview init failed: {stdout}{stderr}")
                self.assertTrue((state_dir / "state.json").exists())
            finally:
                holder_release.touch()
                if contender is not None and contender.poll() is None:
                    contender.communicate(timeout=5)
                holder.communicate(timeout=5)

    def test_promote_retains_previous_web_tree_and_renders_active_slot(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_dir = root / "state"
            first_web = root / "first-web"
            second_web = root / "second-web"
            first_web.mkdir()
            second_web.mkdir()
            (first_web / "index.html").write_text("first", encoding="utf-8")
            (first_web / "assets").mkdir()
            (first_web / "assets" / "old.js").write_text("old", encoding="utf-8")
            (second_web / "index.html").write_text("second", encoding="utf-8")
            (second_web / "assets").mkdir()
            (second_web / "assets" / "new.js").write_text("new", encoding="utf-8")

            self.invoke("init", state_dir)
            first_manifest = root / "first.json"
            self.write_manifest(first_manifest, manifest(first_web, "a" * 40))
            self.invoke("stage", state_dir, manifest=first_manifest)
            self.invoke("commit", state_dir, slot="blue")

            second_manifest = root / "second.json"
            self.write_manifest(second_manifest, manifest(second_web, "b" * 40))
            self.invoke("stage", state_dir, manifest=second_manifest)
            self.invoke("render", state_dir, slot="green", output=state_dir / "caddy" / "Caddyfile.next")
            provisional = (state_dir / "caddy" / "Caddyfile.next").read_text(encoding="utf-8")
            self.assertIn("retained/" + "a" * 40 + "-1{path}", provisional)
            self.invoke("commit", state_dir, slot="green")

            state = control.load_state(state_dir)
            self.assertEqual(state["active_slot"], "green")
            self.assertEqual(state["previous_slot"], "blue")
            self.assertEqual((state_dir / "web" / "current" / "index.html").read_text(encoding="utf-8"), "second")
            retained_key = state["retained"][0]["retained_key"]
            self.assertEqual((state_dir / "web" / "retained" / retained_key / "assets" / "old.js").read_text(encoding="utf-8"), "old")
            caddy = (state_dir / "caddy" / "Caddyfile").read_text(encoding="utf-8")
            self.assertIn("reverse_proxy server-green:8080", caddy)
            self.assertIn(f"/current{{path}} retained/{retained_key}{{path}} /current/index.html", caddy)

    def test_incompatible_candidate_is_rejected_in_both_directions(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_dir = root / "state"
            web = root / "web"
            web.mkdir()
            (web / "index.html").write_text("candidate", encoding="utf-8")
            self.invoke("init", state_dir)
            baseline = root / "baseline.json"
            self.write_manifest(baseline, manifest(web, "a" * 40, state_version=1, read_min=1, read_max=1))
            self.invoke("stage", state_dir, manifest=baseline)
            self.invoke("commit", state_dir, slot="blue")

            incompatible = root / "incompatible.json"
            self.write_manifest(incompatible, manifest(web, "b" * 40, state_version=2, read_min=2, read_max=2))
            with self.assertRaises(control.ContractError):
                self.invoke("stage", state_dir, manifest=incompatible)

    def test_three_promotions_preserve_multiple_retained_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_dir = root / "state"
            self.invoke("init", state_dir)
            manifests = []
            for index, source in enumerate(("a" * 40, "b" * 40, "c" * 40), start=1):
                web = root / f"web-{index}"
                web.mkdir()
                (web / "index.html").write_text(f"candidate-{index}", encoding="utf-8")
                manifest_path = root / f"candidate-{index}.json"
                self.write_manifest(manifest_path, manifest(web, source))
                manifests.append(manifest_path)

            self.invoke("stage", state_dir, manifest=manifests[0])
            self.invoke("commit", state_dir, slot="blue")
            self.invoke("stage", state_dir, manifest=manifests[1])
            self.invoke("commit", state_dir, slot="green")
            self.invoke("stage", state_dir, manifest=manifests[2])
            self.invoke("commit", state_dir, slot="blue")

            state = control.load_state(state_dir)
            self.assertEqual(state["active_slot"], "blue")
            self.assertEqual(state["slots"]["blue"]["source_sha"], "c" * 40)
            self.assertEqual([record["source_sha"] for record in state["retained"]], ["b" * 40, "a" * 40])
            for record, expected in zip(state["retained"], ("candidate-2", "candidate-1")):
                path = state_dir / "web" / "retained" / record["retained_key"] / "index.html"
                self.assertEqual(path.read_text(encoding="utf-8"), expected)
            caddy = (state_dir / "caddy" / "Caddyfile").read_text(encoding="utf-8")
            self.assertLess(caddy.index(f"retained/{state['retained'][0]['retained_key']}{{path}}"), caddy.index(f"retained/{state['retained'][1]['retained_key']}{{path}}"))

            self.invoke("stage-retained", state_dir, retained_key=state["retained"][1]["retained_key"])
            self.assertEqual(control.load_state(state_dir)["pending_slot"], "green")

    def test_manifest_rejects_forged_web_digest(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_dir = root / "state"
            web = root / "web"
            web.mkdir()
            (web / "index.html").write_text("real", encoding="utf-8")
            candidate = manifest(web, "a" * 40)
            candidate["web"]["digest"] = "sha256:" + "f" * 64
            manifest_path = root / "forged.json"
            self.write_manifest(manifest_path, candidate)
            self.invoke("init", state_dir)
            with self.assertRaises(control.ContractError):
                self.invoke("stage", state_dir, manifest=manifest_path)

    def test_switchback_gets_a_new_monotonic_generation(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_dir = root / "state"
            web = root / "web"
            web.mkdir()
            (web / "index.html").write_text("candidate", encoding="utf-8")
            self.invoke("init", state_dir)
            first = root / "first.json"
            second = root / "second.json"
            self.write_manifest(first, manifest(web, "a" * 40))
            self.write_manifest(second, manifest(web, "b" * 40))
            self.invoke("stage", state_dir, manifest=first)
            self.invoke("commit", state_dir, slot="blue")
            self.invoke("stage", state_dir, manifest=second)
            self.invoke("commit", state_dir, slot="green")
            old_generation = control.load_state(state_dir)["slots"]["blue"]["generation"]
            with self.assertRaises(control.ContractError):
                self.invoke("commit", state_dir, slot="blue")
            self.invoke("stage_existing", state_dir, slot="blue")
            new_generation = control.load_state(state_dir)["slots"]["blue"]["generation"]
            self.assertGreater(new_generation, old_generation)


if __name__ == "__main__":
    unittest.main()
