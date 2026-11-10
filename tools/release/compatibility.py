#!/usr/bin/env python3
"""Validate and publish compatibility metadata for Skills and the TypeScript CLI.

The check is deliberately read-only. Publishing is an explicit workflow-dispatch
operation and uses npm's immutable dist-tag update semantics.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from policy import ReleaseError, Version

ROOT = Path(__file__).resolve().parents[2]
SKILL_LABEL = "release:skill"
CLI_LABEL = "release:cli"
VIEWER_LABEL = "release:viewer"
CONTRACT_LABEL = "release:contract"
RELEASE_LABELS = {SKILL_LABEL, CLI_LABEL, VIEWER_LABEL, CONTRACT_LABEL}
SOURCE_SUFFIXES = {".cjs", ".js", ".mjs", ".py", ".sh", ".ts", ".tsx"}
VIEWER_PATHS = (
    "skills/multi-task-flow/web/",
    "skills/multi-task-flow/lib/view",
    "skills/multi-task-flow/lib/service-",
    "skills/multi-task-flow/scripts/build",
    "skills/multi-task-flow/scripts/preview",
)
CONTRACT_PATHS = (
    "skills/multi-task-flow/lib/contract.ts",
    "skills/multi-task-flow/lib/schema.ts",
    "skills/multi-task-flow/lib/store-migration.ts",
    "skills/multi-task-flow/lib/service-contract.ts",
)


def git(*args, cwd=ROOT):
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        raise ReleaseError(result.stderr.strip() or "git command failed")
    return result.stdout


def git_files(base, head):
    return [line for line in git("diff", "--name-only", f"{base}...{head}").splitlines() if line]


def read_at(ref, path):
    try:
        return git("show", f"{ref}:{path}")
    except ReleaseError:
        return None


def json_at(ref, path):
    value = read_at(ref, path)
    if value is None:
        raise ReleaseError(f"missing {path} at {ref}")
    try:
        return json.loads(value)
    except json.JSONDecodeError as error:
        raise ReleaseError(f"invalid JSON in {path} at {ref}: {error}") from error


def skill_version(ref, skill):
    value = read_at(ref, f"skills/{skill}/SKILL.md")
    if value is None:
        raise ReleaseError(f"skill {skill} has no SKILL.md at {ref}")
    match = re.search(r"^version:\s*([^\s]+)\s*$", value, re.MULTILINE)
    if not match:
        raise ReleaseError(f"skill {skill} has no version marker")
    Version(match.group(1))
    return match.group(1)


def cli_version(ref):
    value = json_at(ref, "clients/typescript/package.json").get("version")
    if not isinstance(value, str):
        raise ReleaseError("clients/typescript/package.json has no version")
    Version(value)
    return value


def contract_markers(ref):
    value = read_at(ref, "skills/multi-task-flow/lib/contract.ts")
    if value is None:
        raise ReleaseError(f"missing contract marker at {ref}")
    markers = {}
    for name in ("CONTRACT_VERSION", "VIEWER_CONTRACT", "SKILL_VERSION"):
        match = re.search(rf"export const {name} = (?:\"([^\"]+)\"|(\d+))", value)
        if not match:
            raise ReleaseError(f"missing {name} marker at {ref}")
        markers[name] = match.group(1) or int(match.group(2))
    Version(markers["SKILL_VERSION"])
    return markers


def changed_skill_dirs(files):
    result = set()
    for path in files:
        parts = path.split("/")
        if len(parts) < 3 or parts[0] != "skills" or parts[1] in ("bin", "docs"):
            continue
        result.add(parts[1])
    return sorted(result)


def source_skill_dirs(files):
    result = set()
    for path in files:
        parts = path.split("/")
        if len(parts) < 3 or parts[0] != "skills" or parts[1] in ("bin", "docs"):
            continue
        if Path(path).suffix in SOURCE_SUFFIXES or parts[2] == "SKILL.md":
            result.add(parts[1])
    return sorted(result)


def contract_semantics_changed(base, head, files):
    changed_contract_paths = {
        path for path in files if any(path.startswith(prefix) for prefix in CONTRACT_PATHS)
    }
    if not changed_contract_paths:
        return False
    if changed_contract_paths != {"skills/multi-task-flow/lib/contract.ts"}:
        return True
    before = read_at(base, "skills/multi-task-flow/lib/contract.ts")
    after = read_at(head, "skills/multi-task-flow/lib/contract.ts")
    if before is None or after is None:
        return True
    marker = re.compile(r"export const (?:SKILL_VERSION|VIEWER_CONTRACT) = (?:\"[^\"]+\"|\d+)")
    return marker.sub("", before) != marker.sub("", after)


def required_labels(files, base=None, head=None, before_markers=None, after_markers=None):
    result = set()
    if changed_skill_dirs(files) or (
        before_markers is not None
        and after_markers is not None
        and before_markers["SKILL_VERSION"] != after_markers["SKILL_VERSION"]
    ):
        result.add(SKILL_LABEL)
    if any(path.startswith("clients/typescript/") for path in files):
        result.add(CLI_LABEL)
    if any(any(path.startswith(prefix) for prefix in VIEWER_PATHS) for path in files):
        result.add(VIEWER_LABEL)
    if (base is not None and head is not None and contract_semantics_changed(base, head, files)) or (
        before_markers is not None
        and after_markers is not None
        and before_markers["CONTRACT_VERSION"] != after_markers["CONTRACT_VERSION"]
    ):
        result.add(CONTRACT_LABEL)
    if before_markers is not None and after_markers is not None and before_markers["VIEWER_CONTRACT"] != after_markers["VIEWER_CONTRACT"]:
        result.add(VIEWER_LABEL)
    return result


def _require_advance(kind, before, after):
    if Version(after) <= Version(before):
        raise ReleaseError(f"{kind} version must advance: {before} -> {after}")


def check(base, head, labels=(), require_labels=True):
    files = git_files(base, head)
    provided = {item.strip() for item in labels if item.strip()}
    expected = required_labels(files)
    if require_labels and not expected <= provided:
        missing = ", ".join(sorted(expected - provided))
        raise ReleaseError(f"missing release label(s): {missing}")
    if provided & RELEASE_LABELS and not (provided & expected):
        raise ReleaseError("release labels do not describe the changed surfaces")

    skill_versions = {}
    for skill in source_skill_dirs(files):
        before = skill_version(base, skill)
        after = skill_version(head, skill)
        _require_advance(f"skill {skill}", before, after)
        skill_versions[skill] = after

    cli = None
    if CLI_LABEL in expected:
        before = cli_version(base)
        cli = cli_version(head)
        _require_advance("TypeScript CLI", before, cli)

    before_markers = contract_markers(base)
    after_markers = contract_markers(head)
    expected = required_labels(files, base, head, before_markers, after_markers)
    if require_labels and not expected <= provided:
        missing = ", ".join(sorted(expected - provided))
        raise ReleaseError(f"missing release label(s): {missing}")
    if provided & RELEASE_LABELS and not (provided & expected):
        raise ReleaseError("release labels do not describe the changed surfaces")

    if CONTRACT_LABEL in expected and after_markers["CONTRACT_VERSION"] <= before_markers["CONTRACT_VERSION"]:
        raise ReleaseError("internal contract version must advance for contract changes")
    if VIEWER_LABEL in expected and after_markers["VIEWER_CONTRACT"] <= before_markers["VIEWER_CONTRACT"]:
        raise ReleaseError("viewer contract version must advance for viewer changes")

    return {
        "base_sha": git("rev-parse", base).strip(),
        "head_sha": git("rev-parse", head).strip(),
        "files": files,
        "labels": sorted(provided),
        "required_labels": sorted(expected),
        "skill_versions": skill_versions,
        "cli_version": cli,
        "ledger_contract": after_markers["CONTRACT_VERSION"],
        "viewer_contract": after_markers["VIEWER_CONTRACT"],
        "skill_version": after_markers["SKILL_VERSION"],
        "dist_tag": f"compat-v{after_markers['VIEWER_CONTRACT']}",
    }


def publish(package_dir, tag, dry_run=False):
    directory = Path(os.path.realpath(package_dir))
    root = Path(os.path.realpath(ROOT))
    try:
        directory.relative_to(root)
    except ValueError as error:
        raise ReleaseError("package directory must be inside the checkout") from error
    manifest = json.loads((directory / "package.json").read_text())
    if manifest.get("private") is True:
        raise ReleaseError("private package cannot be published")
    name = manifest.get("name")
    version = manifest.get("version")
    if not isinstance(name, str) or not isinstance(version, str):
        raise ReleaseError("publish package must declare name and version")
    Version(version)
    if not re.fullmatch(r"compat-v[1-9][0-9]*", tag):
        raise ReleaseError("compatibility dist-tag must match compat-vN")
    command = ["npm", "publish", "--tag", tag, "--access", "public"]
    if dry_run:
        return {"package": name, "version": version, "tag": tag, "command": command, "dry_run": True}
    env = os.environ.copy()
    if not env.get("NODE_AUTH_TOKEN"):
        raise ReleaseError("NODE_AUTH_TOKEN is required for compatibility publication")
    result = subprocess.run(command, cwd=directory, env=env, text=True, capture_output=True)
    if result.returncode:
        raise ReleaseError(result.stderr.strip() or "npm publish failed")
    return {"package": name, "version": version, "tag": tag, "dry_run": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    gate = sub.add_parser("check")
    gate.add_argument("--base", required=True)
    gate.add_argument("--head", required=True)
    gate.add_argument("--labels", default="")
    gate.add_argument("--skip-labels", action="store_true")
    metadata = sub.add_parser("metadata")
    metadata.add_argument("--base", required=True)
    metadata.add_argument("--head", required=True)
    metadata.add_argument("--labels", default="")
    metadata.add_argument("--skip-labels", action="store_true")
    publish_parser = sub.add_parser("publish")
    publish_parser.add_argument("--package-dir", required=True)
    publish_parser.add_argument("--tag", required=True)
    publish_parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.action in ("check", "metadata"):
        labels = args.labels.replace("\n", ",").split(",")
        result = check(args.base, args.head, labels, require_labels=not args.skip_labels)
        print(json.dumps(result, sort_keys=True))
    else:
        print(json.dumps(publish(args.package_dir, args.tag, args.dry_run), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, OSError, json.JSONDecodeError) as error:
        print("compatibility-release: " + str(error), file=sys.stderr)
        sys.exit(1)
