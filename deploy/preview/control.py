#!/usr/bin/env python3
"""State and candidate guardrails for the branch-preview blue-green runtime."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = Path(__file__).with_name("Caddyfile.tmpl")
SLOTS = ("blue", "green")
SOURCE_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"@sha256:[0-9a-f]{64}$")


class ContractError(Exception):
    pass


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def die(message: str) -> None:
    raise ContractError(message)


def state_path(state_dir: Path) -> Path:
    return state_dir / "state.json"


def caddy_dir(state_dir: Path) -> Path:
    return state_dir / "caddy"


def web_dir(state_dir: Path) -> Path:
    return state_dir / "web"


def slot_web_dir(state_dir: Path, slot: str) -> Path:
    return web_dir(state_dir) / "slots" / slot


def load_json(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"cannot read JSON {path}: {exc}")
    if not isinstance(value, dict):
        die(f"JSON root must be an object: {path}")
    return value


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_path = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(raw_path)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def write_state(state_dir: Path, state: dict[str, Any]) -> None:
    atomic_write(state_path(state_dir), json.dumps(state, indent=2, sort_keys=True) + "\n")


def load_state(state_dir: Path) -> dict[str, Any]:
    path = state_path(state_dir)
    if not path.exists():
        die(f"preview state is not initialized: run scripts/preview init ({path})")
    state = load_json(path)
    if state.get("schema_version") != 1:
        die(f"unsupported preview state schema: {state.get('schema_version')!r}")
    if state.get("active_slot") not in (None, *SLOTS):
        die("preview state active_slot is invalid")
    if state.get("previous_slot") not in (None, *SLOTS):
        die("preview state previous_slot is invalid")
    if not isinstance(state.get("slots"), dict):
        die("preview state slots must be an object")
    return state


def empty_state() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "active_slot": None,
        "previous_slot": None,
        "pending_slot": None,
        "next_worker_generation": 1,
        "slots": {slot: None for slot in SLOTS},
        "history": [],
    }


def record_event(state: dict[str, Any], event: str, **values: Any) -> None:
    entry = {"event": event, "at": now()}
    entry.update(values)
    state.setdefault("history", []).append(entry)
    state["history"] = state["history"][-100:]


def require_slot(slot: str) -> None:
    if slot not in SLOTS:
        die(f"slot must be one of {', '.join(SLOTS)}")


def validate_manifest(path: Path, check_web: bool = True) -> dict[str, Any]:
    manifest = load_json(path)
    if manifest.get("schema_version") != 1:
        die("candidate schema_version must be 1")
    source_sha = manifest.get("source_sha")
    if not isinstance(source_sha, str) or not SOURCE_RE.fullmatch(source_sha):
        die("candidate source_sha must be 40 lowercase hexadecimal characters")
    artifact_digest = manifest.get("artifact_digest")
    if not isinstance(artifact_digest, str) or not DIGEST_RE.fullmatch(artifact_digest):
        die("candidate artifact_digest must be sha256:<64 lowercase hexadecimal characters>")

    images = manifest.get("images")
    if not isinstance(images, dict):
        die("candidate images must be an object")
    for component in ("server", "worker"):
        image = images.get(component)
        if not isinstance(image, str) or not IMAGE_RE.search(image):
            die(f"candidate images.{component} must be immutable and end with @sha256:<digest>")

    web = manifest.get("web")
    if not isinstance(web, dict) or not isinstance(web.get("root"), str) or not web["root"].strip():
        die("candidate web.root must name the built Web asset directory")
    web_root = Path(web["root"])
    if not web_root.is_absolute():
        web_root = (path.parent / web_root).resolve()
    if check_web and not web_root.is_dir():
        die(f"candidate Web asset directory does not exist: {web_root}")

    compatibility = manifest.get("compatibility")
    if not isinstance(compatibility, dict):
        die("candidate compatibility must be an object")
    state_version = compatibility.get("state_version")
    read_min = compatibility.get("read_min")
    read_max = compatibility.get("read_max")
    if not all(isinstance(value, int) and not isinstance(value, bool) for value in (state_version, read_min, read_max)):
        die("candidate compatibility versions must be integers")
    if state_version < 1 or read_min < 1 or read_min > read_max:
        die("candidate compatibility range is invalid")

    normalized = dict(manifest)
    normalized["web"] = dict(web)
    normalized["web"]["root"] = str(web_root)
    normalized["compatibility"] = {
        "state_version": state_version,
        "read_min": read_min,
        "read_max": read_max,
    }
    normalized["source_sha"] = source_sha
    normalized["artifact_digest"] = artifact_digest
    normalized["images"] = {"server": images["server"], "worker": images["worker"]}
    return normalized


def compatibility_error(current: dict[str, Any] | None, candidate: dict[str, Any]) -> str | None:
    if current is None:
        return None
    current_version = current["compatibility"]["state_version"]
    candidate_range = candidate["compatibility"]
    if not (candidate_range["read_min"] <= current_version <= candidate_range["read_max"]):
        return (
            f"candidate {candidate['source_sha']} cannot read current state version {current_version}; "
            f"supported range is {candidate_range['read_min']}..{candidate_range['read_max']}"
        )
    candidate_version = candidate_range["state_version"]
    current_range = current["compatibility"]
    if not (current_range["read_min"] <= candidate_version <= current_range["read_max"]):
        return (
            f"current candidate {current['source_sha']} cannot read candidate state version {candidate_version}; "
            f"switchback range is {current_range['read_min']}..{current_range['read_max']}"
        )
    return None


def copy_web_assets(state_dir: Path, slot: str, source: Path) -> None:
    destination = slot_web_dir(state_dir, slot)
    source = source.resolve()
    destination = destination.resolve()
    if source == destination or destination.is_relative_to(source):
        die("candidate Web asset directory must not contain the preview slot directory")
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)


def replace_link(path: Path, target: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    if temp.exists() or temp.is_symlink():
        temp.unlink()
    if target is not None:
        os.symlink(target, temp)
        os.replace(temp, path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def slot_record(manifest: dict[str, Any], generation: int, status: str) -> dict[str, Any]:
    return {
        "source_sha": manifest["source_sha"],
        "artifact_digest": manifest["artifact_digest"],
        "images": manifest["images"],
        "web": manifest["web"],
        "compatibility": manifest["compatibility"],
        "generation": generation,
        "status": status,
        "staged_at": now(),
    }


def next_generation(state: dict[str, Any], slot: str) -> int:
    highest = int(state.get("next_worker_generation", 1))
    for record in state["slots"].values():
        if record:
            highest = max(highest, int(record["generation"]) + 1)
    existing = state["slots"].get(slot)
    if existing:
        highest = max(highest, int(existing["generation"]) + 1)
    state["next_worker_generation"] = highest + 1
    return highest


def choose_inactive(state: dict[str, Any]) -> str:
    active = state.get("active_slot")
    if active is None:
        return "blue"
    return "green" if active == "blue" else "blue"


def command_init(args: argparse.Namespace) -> None:
    state_dir = Path(args.state_dir).resolve()
    if state_path(state_dir).exists():
        load_state(state_dir)
        print(f"state={state_path(state_dir)}")
        return
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "caddy").mkdir(parents=True, exist_ok=True)
    (web_dir(state_dir) / "slots").mkdir(parents=True, exist_ok=True)
    write_state(state_dir, empty_state())
    print(f"state={state_path(state_dir)}")


def command_stage(args: argparse.Namespace) -> None:
    state_dir = Path(args.state_dir).resolve()
    state = load_state(state_dir)
    manifest_path = Path(args.manifest).resolve()
    manifest = validate_manifest(manifest_path)
    slot = args.slot or choose_inactive(state)
    require_slot(slot)
    if slot == state.get("active_slot"):
        die(f"cannot stage candidate into active slot {slot}")
    current = state["slots"].get(state.get("active_slot")) if state.get("active_slot") else None
    if error := compatibility_error(current, manifest):
        die(error)
    generation = next_generation(state, slot)
    copy_web_assets(state_dir, slot, Path(manifest["web"]["root"]))
    state["slots"][slot] = slot_record(manifest, generation, "staged")
    state["pending_slot"] = slot
    record_event(state, "stage", slot=slot, source_sha=manifest["source_sha"], artifact_digest=manifest["artifact_digest"], generation=generation)
    write_state(state_dir, state)
    print(f"slot={slot}")
    print(f"generation={generation}")
    print(f"source_sha={manifest['source_sha']}")


def command_stage_existing(args: argparse.Namespace) -> None:
    state_dir = Path(args.state_dir).resolve()
    state = load_state(state_dir)
    slot = args.slot
    require_slot(slot)
    if slot == state.get("active_slot"):
        die(f"cannot stage active slot {slot} for switchback")
    record = state["slots"].get(slot)
    if not record:
        die(f"slot {slot} has no retained candidate")
    current = state["slots"].get(state.get("active_slot")) if state.get("active_slot") else None
    manifest = {
        "source_sha": record["source_sha"],
        "artifact_digest": record["artifact_digest"],
        "images": record["images"],
        "web": record["web"],
        "compatibility": record["compatibility"],
    }
    if error := compatibility_error(current, manifest):
        die(error)
    generation = next_generation(state, slot)
    record.update({"generation": generation, "status": "staged", "staged_at": now()})
    state["pending_slot"] = slot
    record_event(state, "stage_switchback", slot=slot, source_sha=record["source_sha"], artifact_digest=record["artifact_digest"], generation=generation)
    write_state(state_dir, state)
    print(f"slot={slot}")
    print(f"generation={generation}")


def rendered_caddy(slot: str) -> str:
    require_slot(slot)
    return TEMPLATE.read_text(encoding="utf-8").replace("__ACTIVE_SLOT__", slot)


def command_render(args: argparse.Namespace) -> None:
    state_dir = Path(args.state_dir).resolve()
    state = load_state(state_dir)
    slot = args.slot or state.get("active_slot")
    if not slot:
        die("cannot render Caddy before a candidate is staged")
    require_slot(slot)
    if not state["slots"].get(slot):
        die(f"slot {slot} has no candidate")
    output = Path(args.output) if args.output else caddy_dir(state_dir) / "Caddyfile"
    atomic_write(output.resolve(), rendered_caddy(slot))
    print(f"caddyfile={output.resolve()}")


def command_commit(args: argparse.Namespace) -> None:
    state_dir = Path(args.state_dir).resolve()
    state = load_state(state_dir)
    slot = args.slot or state.get("pending_slot")
    if not slot:
        die("no pending candidate to promote")
    require_slot(slot)
    candidate = state["slots"].get(slot)
    if not candidate:
        die(f"slot {slot} has no candidate")
    if state.get("pending_slot") != slot or candidate.get("status") != "staged":
        die(f"slot {slot} is not the staged pending candidate")
    old_slot = state.get("active_slot")
    if old_slot == slot:
        die(f"slot {slot} is already active")
    current = state["slots"].get(old_slot) if old_slot else None
    if error := compatibility_error(current, candidate):
        die(error)

    if old_slot:
        replace_link(web_dir(state_dir) / "retained", f"slots/{old_slot}")
        state["slots"][old_slot]["status"] = "retained"
    replace_link(web_dir(state_dir) / "current", f"slots/{slot}")
    candidate["status"] = "active"
    candidate["activated_at"] = now()
    state["previous_slot"] = old_slot
    state["active_slot"] = slot
    state["pending_slot"] = None
    record_event(state, "promote", slot=slot, previous_slot=old_slot, source_sha=candidate["source_sha"], artifact_digest=candidate["artifact_digest"], generation=candidate["generation"])
    write_state(state_dir, state)
    command_render(argparse.Namespace(state_dir=state_dir, slot=slot, output=None))
    print(f"old_slot={old_slot or ''}")
    print(f"active_slot={slot}")


def env_value(name: str, default: str | None = None, required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        die(f"{name} must be exported before deployment")
    return value or ""


def dotenv(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_./:@?=&+,-]*", value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


def command_compose_env(args: argparse.Namespace) -> None:
    state_dir = Path(args.state_dir).resolve()
    state = load_state(state_dir)
    values: dict[str, str] = {
        "LOOMHELM_PREVIEW_STATE_DIR": str(state_dir),
        "LOOMHELM_PREVIEW_WEB_DIR": str(web_dir(state_dir)),
        "LOOMHELM_PREVIEW_HTTP_PORT": env_value("LOOMHELM_PREVIEW_HTTP_PORT", "18080"),
        "LOOMHELM_PREVIEW_ADMIN_PORT": env_value("LOOMHELM_PREVIEW_ADMIN_PORT", "12019"),
        "LOOMHELM_BLUE_SERVER_PORT": env_value("LOOMHELM_BLUE_SERVER_PORT", "18081"),
        "LOOMHELM_GREEN_SERVER_PORT": env_value("LOOMHELM_GREEN_SERVER_PORT", "18082"),
        "LOOMHELM_DATABASE_URL": env_value("LOOMHELM_DATABASE_URL", required=True),
        "LOOMHELM_DRAIN_TOKEN": env_value("LOOMHELM_DRAIN_TOKEN", required=True),
        "LOOMHELM_DATABASE_MIN_CONNS": env_value("LOOMHELM_DATABASE_MIN_CONNS", "0"),
        "LOOMHELM_DATABASE_MAX_CONNS": env_value("LOOMHELM_DATABASE_MAX_CONNS", "4"),
        "LOOMHELM_POSTGRES_PORT": env_value("LOOMHELM_POSTGRES_PORT", ""),
        "LOOMHELM_SHUTDOWN_TIMEOUT": env_value("LOOMHELM_SHUTDOWN_TIMEOUT", "10s"),
        "LOOMHELM_STARTUP_TIMEOUT": env_value("LOOMHELM_STARTUP_TIMEOUT", "30s"),
        "LOOMHELM_WORKER_LEASE_KEY": env_value("LOOMHELM_WORKER_LEASE_KEY", "loomhelm-worker"),
    }
    for slot in SLOTS:
        prefix = slot.upper()
        record = state["slots"].get(slot)
        values[f"LOOMHELM_{prefix}_SERVER_IMAGE"] = record["images"]["server"] if record else "busybox:1.36"
        values[f"LOOMHELM_{prefix}_WORKER_IMAGE"] = record["images"]["worker"] if record else "busybox:1.36"
        values[f"LOOMHELM_{prefix}_SOURCE_SHA"] = record["source_sha"] if record else "placeholder"
        values[f"LOOMHELM_{prefix}_ARTIFACT_DIGEST"] = record["artifact_digest"] if record else "unknown"
        values[f"LOOMHELM_{prefix}_WORKER_GENERATION"] = str(record["generation"] if record else state["next_worker_generation"])
    output = Path(args.output).resolve()
    atomic_write(output, "".join(f"{key}={dotenv(value)}\n" for key, value in sorted(values.items())))
    print(f"env={output}")


def command_check(args: argparse.Namespace) -> None:
    state_dir = Path(args.state_dir).resolve()
    state = load_state(state_dir)
    candidate = validate_manifest(Path(args.manifest).resolve()) if args.manifest else state["slots"].get(args.slot or state.get("pending_slot"))
    if not candidate:
        die("no candidate supplied or staged")
    current = state["slots"].get(state.get("active_slot")) if state.get("active_slot") else None
    if error := compatibility_error(current, candidate):
        die(error)
    print("compatible=true")
    print(f"source_sha={candidate['source_sha']}")
    print(f"artifact_digest={candidate['artifact_digest']}")


def command_status(args: argparse.Namespace) -> None:
    state = load_state(Path(args.state_dir).resolve())
    if args.field:
        value = state.get(args.field)
        if value is None:
            print("")
        else:
            print(value)
        return
    print(json.dumps(state, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "stage", "stage-existing", "render", "commit", "compose-env", "check", "status"))
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--slot")
    parser.add_argument("--output")
    parser.add_argument("--field")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        {
            "init": command_init,
            "stage": command_stage,
            "stage-existing": command_stage_existing,
            "render": command_render,
            "commit": command_commit,
            "compose-env": command_compose_env,
            "check": command_check,
            "status": command_status,
        }[args.command](args)
    except ContractError as exc:
        print(f"preview: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
