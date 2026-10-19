import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

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
        "web": {"root": str(root)},
        "compatibility": {"state_version": state_version, "read_min": read_min, "read_max": read_max},
    }


class PreviewControlTest(unittest.TestCase):
    def write_manifest(self, path: Path, value: dict) -> None:
        path.write_text(json.dumps(value), encoding="utf-8")

    def invoke(self, name: str, state_dir: Path, **values: str) -> None:
        options = {"state_dir": state_dir, "manifest": None, "slot": None, "output": None, "field": None}
        options.update(values)
        args = Namespace(**options)
        getattr(control, f"command_{name}")(args)

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
            self.invoke("commit", state_dir, slot="green")

            state = control.load_state(state_dir)
            self.assertEqual(state["active_slot"], "green")
            self.assertEqual(state["previous_slot"], "blue")
            self.assertEqual((state_dir / "web" / "current" / "index.html").read_text(encoding="utf-8"), "second")
            self.assertEqual((state_dir / "web" / "retained" / "assets" / "old.js").read_text(encoding="utf-8"), "old")
            caddy = (state_dir / "caddy" / "Caddyfile").read_text(encoding="utf-8")
            self.assertIn("reverse_proxy server-green:8080", caddy)
            self.assertIn("try_files {path} /current{path} /retained{path}", caddy)

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
