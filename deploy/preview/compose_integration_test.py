"""Opt-in Docker Compose configuration checks; run in a session-owned VM."""

import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import control


@unittest.skipUnless(os.environ.get("LOOMHELM_TEST_COMPOSE") == "1", "requires explicit Agent VM Compose validation")
class ComposeAuthenticationTest(unittest.TestCase):
    root = Path(__file__).resolve().parents[2]

    def environment(self) -> dict[str, str]:
        # These are synthetic values; this suite never reads deployment secrets.
        return {
            "LOOMHELM_PREVIEW_PROJECT_NAME": "auth-compose-test",
            "LOOMHELM_PREVIEW_HTTP_PORT": "18080",
            "LOOMHELM_PREVIEW_ADMIN_PORT": "12019",
            "LOOMHELM_BLUE_SERVER_PORT": "18081",
            "LOOMHELM_GREEN_SERVER_PORT": "18082",
            "LOOMHELM_DATABASE_URL": "postgres://fixture:fixture@db/loomhelm",
            "LOOMHELM_DRAIN_TOKEN": "fixture-drain-token",
        }

    def compose_model(self, directory: Path, settings: dict[str, str]) -> dict:
        state = directory / "state"
        output = directory / "compose.env"
        with patch.dict(os.environ, {**self.environment(), **settings}, clear=True), contextlib.redirect_stdout(io.StringIO()):
            control.command_init(Namespace(state_dir=state))
            control.command_compose_env(Namespace(state_dir=state, output=output))
        environment = {key: value for key, value in os.environ.items() if not key.startswith("LOOMHELM_")}
        # Override only the disposable probe image; auth comes from the generated file.
        environment["LOOMHELM_BLUE_SERVER_IMAGE"] = "postgres:17-alpine"
        project = "auth-test-" + directory.name.lower().replace("_", "-")
        compose = ["docker", "compose", "--project-name", project, "--env-file", str(output), "-f", str(self.root / "deploy/preview/compose.yaml")]
        result = subprocess.run(
            [*compose, "config", "--format", "json"],
            env=environment, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, "Compose could not parse the synthetic configuration")
        if "LOOMHELM_OIDC_CLIENT_SECRET" in settings:
            image = subprocess.run(["docker", "image", "inspect", "postgres:17-alpine"], capture_output=True, text=True, timeout=10)
            self.assertEqual(image.returncode, 0, "The Agent VM fixture image must already be present")
            try:
                # Config output re-escapes dollars for further Compose input.
                # Verify actual container delivery as well as that serialized model.
                delivered = subprocess.run(
                    [*compose, "run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "server-blue", "-c", 'test "$LOOMHELM_OIDC_CLIENT_SECRET" = "$1"', "fixture", settings["LOOMHELM_OIDC_CLIENT_SECRET"]],
                    env=environment, capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(delivered.returncode, 0, "Compose did not deliver the literal synthetic credential")
            finally:
                cleanup = subprocess.run([*compose, "down", "--remove-orphans", "--volumes"], env=environment, capture_output=True, text=True, timeout=30)
                self.assertEqual(cleanup.returncode, 0, "Could not clean up this fixture's Compose resources")
        return json.loads(result.stdout)

    def test_literal_credentials_reach_both_servers_without_worker_exposure(self) -> None:
        secrets = ["plain-secret", "single'quote", 'double"quote', r"back\slash", "trailing\\", "slash\\'quote", "$HOME", "${HOME}", "$$literal", " white space ", "hash#comment", "line\nbreak", "tab\tvalue", "nonascii-凭据"]
        for secret in secrets:
            with self.subTest(secret_case=secrets.index(secret)), tempfile.TemporaryDirectory() as raw:
                settings = {
                    "LOOMHELM_OIDC_ISSUER_URL": "https://issuer.example.test",
                    "LOOMHELM_OIDC_CLIENT_ID": "preview-client",
                    "LOOMHELM_OIDC_CLIENT_SECRET": secret,
                    "LOOMHELM_OIDC_REDIRECT_URL": "https://preview.example.test/api/v1/auth/oidc/callback",
                }
                services = self.compose_model(Path(raw), settings)["services"]
                for slot in ("blue", "green"):
                    server = services[f"server-{slot}"]["environment"]
                    for key, expected in settings.items():
                        self.assertEqual(server[key], expected.replace("$", "$$"))
                    self.assertEqual(server["LOOMHELM_SESSION_COOKIE_SECURE"], "true")
                    worker = services[f"worker-{slot}"]["environment"]
                    self.assertFalse(set(settings).intersection(worker))
                    self.assertNotIn("LOOMHELM_SESSION_COOKIE_SECURE", worker)

    def test_disabled_login_and_explicit_http_cookie_setting(self) -> None:
        for secure in (None, "false"):
            with self.subTest(secure=secure), tempfile.TemporaryDirectory() as raw:
                settings = {} if secure is None else {"LOOMHELM_SESSION_COOKIE_SECURE": secure}
                services = self.compose_model(Path(raw), settings)["services"]
                for slot in ("blue", "green"):
                    server = services[f"server-{slot}"]["environment"]
                    for key in ("LOOMHELM_OIDC_ISSUER_URL", "LOOMHELM_OIDC_CLIENT_ID", "LOOMHELM_OIDC_CLIENT_SECRET", "LOOMHELM_OIDC_REDIRECT_URL"):
                        self.assertEqual(server[key], "")
                    self.assertEqual(server["LOOMHELM_SESSION_COOKIE_SECURE"], secure or "true")

    def test_preview_compose_config_validates_without_printing_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            repo = directory / "repo"
            for relative in ("scripts/preview", "deploy/preview/control.py", "deploy/preview/compose.yaml", "deploy/preview/Caddyfile.tmpl"):
                target = repo / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self.root / relative, target)
            subprocess.run(["git", "init", "--quiet", str(repo)], check=True, capture_output=True, timeout=10)
            environment = {key: value for key, value in os.environ.items() if not key.startswith("LOOMHELM_")}
            environment.update(self.environment())
            environment.update({
                "LOOMHELM_PREVIEW_STATE_DIR": str(directory / "state"),
                "LOOMHELM_OIDC_CLIENT_SECRET": "fixture-private-client-secret",
                "LOOMHELM_SHUTDOWN_TIMEOUT": "120s",
                # This intentionally conflicts with the generated lower bound
                # so the wrapper must prove that compose.env wins.
                "LOOMHELM_STOP_GRACE_PERIOD": "5s",
            })
            for command in ("init", "compose-config"):
                result = subprocess.run([str(repo / "scripts/preview"), command], cwd=repo, env=environment, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, f"preview {command} failed for synthetic configuration")
                for secret in (environment["LOOMHELM_OIDC_CLIENT_SECRET"], environment["LOOMHELM_DRAIN_TOKEN"], environment["LOOMHELM_DATABASE_URL"]):
                    self.assertNotIn(secret, result.stdout + result.stderr)
            compose = [
                "docker", "compose", "--project-name", environment["LOOMHELM_PREVIEW_PROJECT_NAME"],
                "--env-file", str(directory / "state" / "compose.env"),
                "-f", str(repo / "deploy/preview/compose.yaml"), "config", "--format", "json",
            ]
            config = subprocess.run(["env", "-u", "LOOMHELM_STOP_GRACE_PERIOD", *compose], cwd=repo, env=environment, capture_output=True, text=True, timeout=30)
            self.assertEqual(config.returncode, 0, "Compose could not resolve the generated shutdown grace period")
            services = json.loads(config.stdout)["services"]
            for service in ("server-blue", "server-green", "worker-blue", "worker-green"):
                self.assertEqual(services[service]["stop_grace_period"], "6m", service)


if __name__ == "__main__":
    unittest.main()
