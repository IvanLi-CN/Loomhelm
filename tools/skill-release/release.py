#!/usr/bin/env python3
"""Eligibility and artifact checks for the standalone Skill package release."""

from __future__ import annotations

import argparse
import hashlib
import json
import locale
import re
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from functools import total_ordering
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping


PACKAGE_NAME = "@loomhelm/multi-task-flow"
PACKAGE_JSON = Path("clients/typescript/package.json")
SKILL_DOCUMENT = Path("skills/multi-task-flow/SKILL.md")
CONTRACT_SOURCE = Path("skills/multi-task-flow/lib/contract.ts")
SERVICE_CONTRACT_SOURCE = Path("skills/multi-task-flow/lib/service-contract.ts")
RELEASE_TAG_PREFIX = "multi-task-flow-v"
RELEASE_LABELS = frozenset({"release:skill", "release:skill-initial-publication", "release:skip"})
RELEASE_PATH_PREFIXES = (
    ".github/workflows/",
    "clients/typescript/",
    "skills/",
    "tools/skill-release/",
)
SHA1 = re.compile(r"^[a-f0-9]{40}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
EXACT_SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
COMPATIBILITY_LINE = re.compile(r"^compat-v([1-9][0-9]*)$")
MAX_SAFE_INTEGER = (1 << 53) - 1


class ReleaseError(ValueError):
    """A deterministic release eligibility or artifact validation failure."""


@total_ordering
class Version:
    """The exact SemVer subset accepted by the package runtime."""

    def __init__(self, text: str):
        if not isinstance(text, str):
            raise ReleaseError("version must be a string")
        match = EXACT_SEMVER.fullmatch(text)
        if match is None:
            raise ReleaseError(f"invalid exact SemVer: {text!r}")
        core = tuple(int(match[index]) for index in range(1, 4))
        if any(value > MAX_SAFE_INTEGER for value in core):
            raise ReleaseError(f"SemVer component is too large: {text!r}")
        prerelease = tuple(match[4].split(".")) if match[4] else ()
        if any(part.isdigit() and len(part) > 1 and part.startswith("0") for part in prerelease):
            raise ReleaseError(f"prerelease numeric identifier has a leading zero: {text!r}")
        self.text = text
        self.core = core
        self.prerelease = prerelease

    def _key(self) -> tuple[Any, ...]:
        identifiers = tuple(
            (0, int(part)) if part.isdigit() else (1, part)
            for part in self.prerelease
        )
        return self.core, not self.prerelease, identifiers

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, Version):
            return NotImplemented
        return self._key() < other._key()

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Version) and self._key() == other._key()

    def __hash__(self) -> int:
        return hash(self._key())


@dataclass(frozen=True)
class Compatibility:
    text: str
    number: int


def parse_compatibility(value: str) -> Compatibility:
    if not isinstance(value, str):
        raise ReleaseError("compatibility line must be a string")
    match = COMPATIBILITY_LINE.fullmatch(value)
    if match is None:
        raise ReleaseError(f"invalid compatibility line: {value!r}")
    number = int(match[1])
    if number > MAX_SAFE_INTEGER:
        raise ReleaseError(f"compatibility line is too large: {value!r}")
    return Compatibility(value, number)


@dataclass(frozen=True)
class Projection:
    package_name: str
    package_version: str
    compatibility_line: str
    skill_version: str
    ledger_contract: int
    api_version: int
    frontend_contract: int
    viewer_contract: int
    service_version: str

    @property
    def version(self) -> Version:
        return Version(self.package_version)

    @property
    def compatibility(self) -> Compatibility:
        return parse_compatibility(self.compatibility_line)

    def canonical_identity(self) -> tuple[Any, ...]:
        return (
            self.package_name,
            self.package_version,
            self.compatibility_line,
            self.skill_version,
            self.ledger_contract,
            self.api_version,
            self.frontend_contract,
            self.viewer_contract,
            self.service_version,
        )


@dataclass(frozen=True)
class GateResult:
    relevant: bool
    decision: str
    base_version: str | None
    head_version: str | None
    compatibility_line: str | None
    changed_paths: tuple[str, ...]
    reason: str | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "relevant": self.relevant,
            "decision": self.decision,
            "base_version": self.base_version,
            "head_version": self.head_version,
            "compatibility_line": self.compatibility_line,
            "changed_paths": list(self.changed_paths),
            "reason": self.reason,
        }


def _require_object(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ReleaseError(f"{field} must be an object")
    return value


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ReleaseError(f"{field} must be a non-empty string")
    return value


def _require_positive_integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ReleaseError(f"{field} must be a positive integer")
    if value > MAX_SAFE_INTEGER:
        raise ReleaseError(f"{field} is too large")
    return value


def _read_json_bytes(data: bytes, field: str) -> Mapping[str, Any]:
    try:
        return _require_object(json.loads(data.decode("utf-8")), field)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReleaseError(f"{field} is not valid UTF-8 JSON") from error


def _git_show(root: Path, revision: str, path: Path) -> bytes:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "show", f"{revision}:{path.as_posix()}"],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as error:
        raise ReleaseError(f"cannot read {path} at revision {revision}") from error
    return result.stdout


def _read_source(root: Path, revision: str | None, path: Path) -> bytes:
    if revision is not None:
        return _git_show(root, revision, path)
    try:
        return (root / path).read_bytes()
    except OSError as error:
        raise ReleaseError(f"cannot read source file: {path}") from error


def _constant(text: str, name: str, *, quoted: bool = False) -> str:
    if quoted:
        pattern = rf"export\s+const\s+{re.escape(name)}\s*=\s*[\"']([^\"']+)[\"']"
    else:
        pattern = rf"export\s+const\s+{re.escape(name)}\s*=\s*([0-9]+)"
    match = re.search(pattern, text)
    if match is None:
        raise ReleaseError(f"missing source contract constant: {name}")
    return match[1]


def load_projection(root: Path, revision: str | None = None) -> Projection:
    package = _read_json_bytes(_read_source(root, revision, PACKAGE_JSON), "package.json")
    package_name = _require_string(package.get("name"), "package.name")
    package_version = _require_string(package.get("version"), "package.version")
    Version(package_version)
    metadata = _require_object(package.get("loomhelm"), "package.loomhelm")
    compatibility_line = _require_string(metadata.get("compatibilityLine"), "package.loomhelm.compatibilityLine")
    parse_compatibility(compatibility_line)
    skill_version = _require_string(metadata.get("skillVersion"), "package.loomhelm.skillVersion")
    Version(skill_version)
    contracts = _require_object(metadata.get("contracts"), "package.loomhelm.contracts")
    ledger_contract = _require_positive_integer(contracts.get("ledger"), "package.loomhelm.contracts.ledger")
    api_version = _require_positive_integer(contracts.get("api"), "package.loomhelm.contracts.api")
    frontend_contract = _require_positive_integer(contracts.get("frontend"), "package.loomhelm.contracts.frontend")
    viewer_contract = _require_positive_integer(contracts.get("viewer"), "package.loomhelm.contracts.viewer")
    service_version = _require_string(contracts.get("service"), "package.loomhelm.contracts.service")

    skill_document = _read_source(root, revision, SKILL_DOCUMENT).decode("utf-8")
    skill_version_match = re.search(r"^version:\s*([^\s]+)\s*$", skill_document, re.MULTILINE)
    if skill_version_match is None:
        raise ReleaseError("Skill document has no frontmatter version")
    documented_skill_version = skill_version_match[1]
    Version(documented_skill_version)
    if documented_skill_version != skill_version:
        raise ReleaseError("package Skill version does not match SKILL.md")

    contract_source = _read_source(root, revision, CONTRACT_SOURCE).decode("utf-8")
    source_skill_version = _constant(contract_source, "SKILL_VERSION", quoted=True)
    source_ledger_contract = int(_constant(contract_source, "CONTRACT_VERSION"))
    source_viewer_contract = int(_constant(contract_source, "VIEWER_CONTRACT"))
    if source_skill_version != skill_version:
        raise ReleaseError("package Skill version does not match lib/contract.ts")
    if source_ledger_contract != ledger_contract:
        raise ReleaseError("package ledger contract does not match lib/contract.ts")
    if source_viewer_contract != viewer_contract:
        raise ReleaseError("package viewer contract does not match lib/contract.ts")

    service_source = _read_source(root, revision, SERVICE_CONTRACT_SOURCE).decode("utf-8")
    source_api_version = int(_constant(service_source, "API_VERSION"))
    source_frontend_contract = int(_constant(service_source, "FRONTEND_CONTRACT"))
    if source_api_version != api_version:
        raise ReleaseError("package API version does not match lib/service-contract.ts")
    if source_frontend_contract != frontend_contract:
        raise ReleaseError("package frontend contract does not match lib/service-contract.ts")
    if package_name != PACKAGE_NAME:
        raise ReleaseError(f"unexpected package name: {package_name}")

    return Projection(
        package_name=package_name,
        package_version=package_version,
        compatibility_line=compatibility_line,
        skill_version=skill_version,
        ledger_contract=ledger_contract,
        api_version=api_version,
        frontend_contract=frontend_contract,
        viewer_contract=viewer_contract,
        service_version=service_version,
    )


def load_base_projection(root: Path, revision: str) -> Projection | None:
    """Load a release baseline, allowing the repository's first Skill projection.

    The first Skill release is allowed to introduce ``package.loomhelm``. Older
    mainline commits predate that metadata, so treating the missing object as a
    normal release baseline would reject the very PR that establishes it.
    Other malformed or partially present metadata remains a hard failure.
    """
    try:
        return load_projection(root, revision)
    except ReleaseError as error:
        if str(error) == "package.loomhelm must be an object":
            return None
        raise


def changed_paths(root: Path, base: str, head: str) -> tuple[str, ...]:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "diff", "--name-only", "--diff-filter=ACMRTUXB", f"{base}...{head}"],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        raise ReleaseError("cannot compute the release gate Git diff") from error
    paths = tuple(sorted(path for path in result.stdout.splitlines() if path))
    if not paths:
        raise ReleaseError("release gate diff is empty")
    return paths


def is_release_path(path: str) -> bool:
    return any(path == prefix.rstrip("/") or path.startswith(prefix) for prefix in RELEASE_PATH_PREFIXES)


def _normalise_labels(labels: Iterable[str]) -> tuple[str, ...]:
    values = tuple(label.strip() for label in labels if label.strip())
    release_labels = tuple(label for label in values if label.startswith("release:"))
    if len(release_labels) != 1 or release_labels[0] not in RELEASE_LABELS:
        if not release_labels:
            raise ReleaseError(
                "related PR must have exactly one release:skill, "
                "release:skill-initial-publication, or release:skip label"
            )
        raise ReleaseError("related PR has conflicting or unknown release labels")
    if len(values) != len(set(values)):
        raise ReleaseError("PR labels contain duplicates; re-run the release gate")
    return values


def _skip_reason_from_body(body: str) -> str | None:
    marker = re.search(r"<!--\s*release-skip\s*:\s*(.*?)\s*-->", body, re.IGNORECASE | re.DOTALL)
    if marker:
        reason = " ".join(marker[1].split())
        return reason or None
    heading = re.search(r"^release skip reason\s*:\s*(.+?)\s*$", body, re.IGNORECASE | re.MULTILINE)
    if heading:
        return heading[1].strip()
    return None


def _event_metadata(event_path: Path) -> dict[str, Any]:
    try:
        event = json.loads(event_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"cannot read GitHub event payload: {event_path}") from error
    if not isinstance(event, dict):
        raise ReleaseError("GitHub event payload must be an object")
    pull_request = event.get("pull_request")
    if not isinstance(pull_request, dict):
        raise ReleaseError("release gate requires a pull_request event")
    labels = pull_request.get("labels")
    if not isinstance(labels, list):
        raise ReleaseError("pull_request labels are missing")
    names = []
    for label in labels:
        if isinstance(label, dict) and isinstance(label.get("name"), str):
            names.append(label["name"])
    base = _require_object(pull_request.get("base"), "pull_request.base")
    head = _require_object(pull_request.get("head"), "pull_request.head")
    base_sha = _require_string(base.get("sha"), "pull_request.base.sha")
    head_sha = _require_string(head.get("sha"), "pull_request.head.sha")
    # Child PRs target delivery-unit branches; publish-time verification requires main.
    _require_string(base.get("ref"), "pull_request.base.ref")
    if pull_request.get("draft") is True:
        raise ReleaseError("draft PRs are not release-eligible")
    return {
        "labels": names,
        "base_sha": base_sha,
        "head_sha": head_sha,
        "skip_reason": _skip_reason_from_body(pull_request.get("body") or ""),
    }


def evaluate_gate(
    root: Path,
    *,
    base: str,
    head: str,
    labels: Iterable[str],
    skip_reason: str | None = None,
    initial_publication: bool = False,
    registry_version_missing: bool = False,
) -> GateResult:
    paths = changed_paths(root, base, head)
    if not any(is_release_path(path) for path in paths):
        return GateResult(False, "unrelated", None, None, None, paths)

    normalised_labels = _normalise_labels(labels)
    decision = next(label for label in normalised_labels if label in RELEASE_LABELS)
    base_projection = load_base_projection(root, base)
    head_projection = load_projection(root, head)

    if decision == "release:skip":
        reason = (skip_reason or "").strip()
        if not reason:
            raise ReleaseError("release:skip requires an explicit skip reason")
        if base_projection is None:
            raise ReleaseError("release:skip cannot establish the first Skill projection")
        if base_projection.canonical_identity() != head_projection.canonical_identity():
            raise ReleaseError("release:skip cannot change package or Skill canonical identity")
        return GateResult(
            True,
            decision,
            base_projection.package_version,
            head_projection.package_version,
            head_projection.compatibility_line,
            paths,
            reason,
        )

    if decision == "release:skill-initial-publication":
        if not initial_publication or not registry_version_missing:
            raise ReleaseError("initial Skill publication requires an unpublished exact registry version")
        if base_projection is None:
            raise ReleaseError("initial Skill publication requires an existing main projection")
        if base_projection.canonical_identity() != head_projection.canonical_identity():
            raise ReleaseError("initial Skill publication cannot change canonical identity")
        return GateResult(
            True,
            decision,
            base_projection.package_version,
            head_projection.package_version,
            head_projection.compatibility_line,
            paths,
            "exact npm package version is unpublished",
        )

    if base_projection is not None and not head_projection.version > base_projection.version:
        raise ReleaseError(
            f"release version must strictly advance {base_projection.package_version}; "
            f"got {head_projection.package_version}"
        )
    if base_projection is not None and head_projection.compatibility.number < base_projection.compatibility.number:
        raise ReleaseError("compatibility line cannot move backwards")
    return GateResult(
        True,
        decision,
        base_projection.package_version if base_projection is not None else None,
        head_projection.package_version,
        head_projection.compatibility_line,
        paths,
    )


def _safe_archive_path(name: str) -> str:
    if not name or "\\" in name or name.startswith("/"):
        raise ReleaseError(f"unsafe tarball path: {name!r}")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ReleaseError(f"unsafe tarball path: {name!r}")
    if parts[0] != "package":
        raise ReleaseError("tarball contains a path outside package/")
    return "/".join(parts[1:])


def archive_files(tarball: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    seen: set[str] = set()
    try:
        archive = tarfile.open(tarball, mode="r:gz")
    except (OSError, tarfile.TarError) as error:
        raise ReleaseError(f"cannot read package tarball: {tarball}") from error
    with archive:
        for member in archive.getmembers():
            relative = _safe_archive_path(member.name)
            if not relative:
                if not member.isdir():
                    raise ReleaseError("package root must be a directory")
                continue
            if relative in seen:
                raise ReleaseError(f"tarball contains duplicate path: {relative}")
            seen.add(relative)
            if member.isdir():
                continue
            if not member.isfile() or member.issym() or member.islnk():
                raise ReleaseError(f"tarball contains an unsupported entry: {member.name}")
            extracted = archive.extractfile(member)
            if extracted is None:
                raise ReleaseError(f"tarball file has no content: {member.name}")
            files[relative] = extracted.read()
    if "package.json" not in files:
        raise ReleaseError("tarball does not contain package/package.json")
    return files


def _locale_sorted(values: Iterable[Any], key: Callable[[Any], str]) -> list[Any]:
    previous_locale = locale.setlocale(locale.LC_COLLATE)
    try:
        try:
            locale.setlocale(locale.LC_COLLATE, "en_US.UTF-8")
        except locale.Error as error:
            raise ReleaseError("en-US collation is required to verify TypeScript release identity") from error
        return sorted(values, key=lambda value: locale.strxfrm(key(value)))
    finally:
        locale.setlocale(locale.LC_COLLATE, previous_locale)


def canonical_tarball_digest(tarball: Path) -> str:
    files = archive_files(tarball)
    digest = hashlib.sha256()
    for path in _locale_sorted(files, lambda value: value):
        if path == "toolkit/artifact-manifest.json":
            continue
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(files[path])
        digest.update(b"\0")
    return digest.hexdigest()


def _validate_identity(identity: Mapping[str, Any]) -> None:
    if identity.get("packageName") != PACKAGE_NAME:
        raise ReleaseError("artifact identity has an unexpected package name")
    package_version = _require_string(identity.get("packageVersion"), "identity.packageVersion")
    Version(package_version)
    compatibility = _require_string(identity.get("compatibilityLine"), "identity.compatibilityLine")
    parse_compatibility(compatibility)
    skill_version = _require_string(identity.get("skillVersion"), "identity.skillVersion")
    Version(skill_version)
    source_sha = _require_string(identity.get("sourceSha"), "identity.sourceSha")
    if not SHA1.fullmatch(source_sha):
        raise ReleaseError("artifact identity sourceSha is not a full SHA-1")
    merge_sha = identity.get("mergeSha")
    if merge_sha is not None and (not isinstance(merge_sha, str) or not SHA1.fullmatch(merge_sha)):
        raise ReleaseError("artifact identity mergeSha is invalid")
    if not isinstance(identity.get("dirty"), bool):
        raise ReleaseError("artifact identity dirty must be boolean")
    contracts = _require_object(identity.get("contracts"), "identity.contracts")
    for field in ("ledgerContract", "apiVersion", "frontendContract", "viewerContract"):
        _require_positive_integer(contracts.get(field), f"identity.contracts.{field}")
    _require_string(contracts.get("serviceVersion"), "identity.contracts.serviceVersion")
    build_id = _require_string(identity.get("buildId"), "identity.buildId")
    if not SHA256.fullmatch(build_id):
        raise ReleaseError("artifact identity buildId is invalid")
    tarball_digest = identity.get("tarballDigest")
    if tarball_digest is not None and (not isinstance(tarball_digest, str) or not SHA256.fullmatch(tarball_digest)):
        raise ReleaseError("artifact identity tarballDigest is invalid")
    git_tag = identity.get("gitTag")
    if git_tag is not None and git_tag != f"{RELEASE_TAG_PREFIX}{package_version}":
        raise ReleaseError("artifact identity Git tag does not match package version")


def identity_digest(identity: Mapping[str, Any], files: Iterable[Mapping[str, str]]) -> str:
    body = dict(identity)
    body.pop("buildId", None)
    file_values = [dict(item) for item in files]
    body["files"] = _locale_sorted(file_values, lambda item: item["path"])
    encoded = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_tarball(
    tarball: Path,
    *,
    expected_version: str | None = None,
    expected_merge_sha: str | None = None,
    expected_compatibility: str | None = None,
    require_tag: bool = True,
) -> dict[str, Any]:
    files = archive_files(tarball)
    package = _read_json_bytes(files["package.json"], "tarball package.json")
    if package.get("name") != PACKAGE_NAME:
        raise ReleaseError("tarball package.json has an unexpected package name")
    package_version = _require_string(package.get("version"), "tarball package.version")
    Version(package_version)
    if expected_version is not None and package_version != expected_version:
        raise ReleaseError("tarball package version does not match the release request")
    if "toolkit/artifact-manifest.json" not in files:
        raise ReleaseError("tarball does not contain toolkit/artifact-manifest.json")
    artifact = _read_json_bytes(files["toolkit/artifact-manifest.json"], "artifact manifest")
    if artifact.get("schemaVersion") != 2 or artifact.get("runtime") != "bun@1.4.4":
        raise ReleaseError("artifact manifest has an unsupported schema or runtime")
    identity = _require_object(artifact.get("identity"), "artifact.identity")
    _validate_identity(identity)
    for field in (
        "packageName",
        "packageVersion",
        "compatibilityLine",
        "skillVersion",
        "sourceSha",
        "mergeSha",
        "dirty",
        "buildId",
        "tarballDigest",
        "gitTag",
    ):
        if artifact.get(field) != identity.get(field):
            raise ReleaseError(f"artifact identity projection mismatch: {field}")
    if artifact.get("packageName") != PACKAGE_NAME or artifact.get("packageVersion") != package_version:
        raise ReleaseError("artifact package identity does not match package.json")
    compatibility = _require_string(artifact.get("compatibilityLine"), "artifact.compatibilityLine")
    parse_compatibility(compatibility)
    if expected_compatibility is not None and compatibility != expected_compatibility:
        raise ReleaseError("tarball compatibility line does not match the release request")
    source_sha = _require_string(artifact.get("sourceSha"), "artifact.sourceSha")
    merge_sha = artifact.get("mergeSha")
    if not SHA1.fullmatch(source_sha) or merge_sha != source_sha:
        raise ReleaseError("publication artifact must bind sourceSha and mergeSha to one commit")
    if expected_merge_sha is not None and merge_sha != expected_merge_sha:
        raise ReleaseError("tarball merge SHA does not match the release request")
    if artifact.get("candidateSha") != source_sha or artifact.get("dirty") is not False:
        raise ReleaseError("publication artifact is not a clean source candidate")
    tag = artifact.get("gitTag")
    if require_tag and tag != f"{RELEASE_TAG_PREFIX}{package_version}":
        raise ReleaseError("publication artifact does not carry its immutable release tag")

    inventory = artifact.get("files")
    if not isinstance(inventory, list) or not inventory:
        raise ReleaseError("artifact manifest has no resource inventory")
    inventory_paths: set[str] = set()
    for item in inventory:
        item_object = _require_object(item, "artifact.files[]")
        path = _require_string(item_object.get("path"), "artifact.files[].path")
        digest = _require_string(item_object.get("sha256"), "artifact.files[].sha256")
        if path in inventory_paths or not SHA256.fullmatch(digest):
            raise ReleaseError("artifact resource inventory is invalid")
        inventory_paths.add(path)
        resource = f"toolkit/{path}"
        if resource not in files or hashlib.sha256(files[resource]).hexdigest() != digest:
            raise ReleaseError(f"artifact resource digest mismatch: {path}")
    if identity_digest(identity, inventory) != identity.get("buildId"):
        raise ReleaseError("artifact build ID does not match the resource inventory")

    digest = canonical_tarball_digest(tarball)
    if identity.get("tarballDigest") != digest:
        raise ReleaseError("tarball digest does not match artifact identity")
    return {
        "packageName": PACKAGE_NAME,
        "packageVersion": package_version,
        "compatibilityLine": compatibility,
        "mergeSha": merge_sha,
        "buildId": identity["buildId"],
        "tarballDigest": digest,
        "gitTag": tag,
        "files": len(files),
    }


def _gh_api(repository: str, path: str, *, method: str = "GET", fields: Mapping[str, str] | None = None) -> Any:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ReleaseError("invalid GitHub repository")
    command = ["gh", "api", f"repos/{repository}/{path}", "--method", method]
    for name, value in (fields or {}).items():
        command.extend(["-f", f"{name}={value}"])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        if method == "GET" and "404" in result.stderr:
            return None
        raise ReleaseError("GitHub tag operation failed; reconcile before retry")
    if not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ReleaseError("GitHub returned a non-JSON tag response") from error


def github_tag_commit(repository: str, tag: str) -> str | None:
    """Resolve a lightweight or annotated tag without ever following a mutable ref twice."""
    reference = _gh_api(repository, f"git/ref/tags/{tag}")
    if reference is None:
        return None
    object_value = _require_object(reference.get("object"), "GitHub tag object")
    visited: set[str] = set()
    while True:
        object_type = _require_string(object_value.get("type"), "GitHub tag object type")
        object_sha = _require_string(object_value.get("sha"), "GitHub tag object SHA")
        if object_sha in visited:
            raise ReleaseError("GitHub tag object cycle detected")
        visited.add(object_sha)
        if object_type == "commit":
            if not SHA1.fullmatch(object_sha):
                raise ReleaseError("GitHub tag commit is not a full SHA-1")
            return object_sha
        if object_type != "tag":
            raise ReleaseError("GitHub tag does not resolve to a commit")
        tag_object = _gh_api(repository, f"git/tags/{object_sha}")
        if tag_object is None:
            raise ReleaseError("GitHub annotated tag object is missing")
        object_value = _require_object(tag_object.get("object"), "GitHub annotated tag object")


def ensure_github_tag(repository: str, tag: str, commit_sha: str) -> str:
    if not tag.startswith(RELEASE_TAG_PREFIX):
        raise ReleaseError("GitHub tag must use the immutable multi-task-flow-vX.Y.Z format")
    Version(tag.removeprefix(RELEASE_TAG_PREFIX))
    if not SHA1.fullmatch(commit_sha):
        raise ReleaseError("GitHub tag commit must be a full SHA-1")
    existing = github_tag_commit(repository, tag)
    if existing is not None:
        if existing != commit_sha:
            raise ReleaseError("GitHub tag already points to a different commit")
        return existing
    try:
        _gh_api(
            repository,
            "git/refs",
            method="POST",
            fields={"ref": f"refs/tags/{tag}", "sha": commit_sha},
        )
    except ReleaseError:
        reconciled = github_tag_commit(repository, tag)
        if reconciled == commit_sha:
            return reconciled
        raise
    reconciled = github_tag_commit(repository, tag)
    if reconciled != commit_sha:
        raise ReleaseError("GitHub tag creation did not produce the requested immutable identity")
    return reconciled


def dist_tag_action(current: str | None, target: str) -> str:
    """Return the only safe action for a monotonic npm dist-tag promotion."""
    target_version = Version(target)
    if current is None or not current.strip() or current.strip() == "null":
        return "promote"
    try:
        value = json.loads(current)
    except json.JSONDecodeError as error:
        raise ReleaseError("npm returned invalid dist-tag metadata") from error
    if not isinstance(value, str):
        raise ReleaseError("npm dist-tag metadata is not a version string")
    current_version = Version(value)
    if current_version > target_version:
        raise ReleaseError("dist-tag points to a newer version; refusing regression")
    return "keep" if current_version == target_version else "promote"


def _labels_argument(value: str | None) -> list[str]:
    if value is None:
        return []
    if value.lstrip().startswith("["):
        parsed = json.loads(value)
        if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
            raise ReleaseError("--labels JSON must be an array of strings")
        return parsed
    return [item for item in value.split(",") if item.strip()]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    gate = subparsers.add_parser("gate", help="validate PR release eligibility")
    gate.add_argument("--repo-root", type=Path, default=Path("."))
    gate.add_argument("--base")
    gate.add_argument("--head")
    gate.add_argument("--labels")
    gate.add_argument("--skip-reason")
    gate.add_argument("--event-path", type=Path)
    gate.add_argument("--initial-publication", action="store_true")
    gate.add_argument("--registry-version-missing", action="store_true")

    digest = subparsers.add_parser("tarball-digest", help="print the canonical tarball digest")
    digest.add_argument("tarball", type=Path)

    validate = subparsers.add_parser("validate-tarball", help="validate a package tarball")
    validate.add_argument("tarball", type=Path)
    validate.add_argument("--version")
    validate.add_argument("--merge-sha")
    validate.add_argument("--compatibility-line")
    validate.add_argument("--allow-missing-tag", action="store_true")

    tag = subparsers.add_parser("verify-tag", help="verify an immutable GitHub tag")
    tag.add_argument("--repository", required=True)
    tag.add_argument("--tag", required=True)
    tag.add_argument("--sha", required=True)
    tag.add_argument("--create", action="store_true")
    tag.add_argument("--allow-missing", action="store_true")

    policy = subparsers.add_parser("dist-tag-policy", help="check monotonic npm dist-tag promotion")
    policy.add_argument("--current")
    policy.add_argument("--target", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "gate":
            metadata = _event_metadata(args.event_path) if args.event_path else {}
            base = args.base or metadata.get("base_sha")
            head = args.head or metadata.get("head_sha")
            if not base or not head:
                raise ReleaseError("gate requires --base and --head or --event-path")
            labels = _labels_argument(args.labels) if args.labels is not None else metadata.get("labels", [])
            skip_reason = args.skip_reason
            if skip_reason is None:
                skip_reason = metadata.get("skip_reason")
            result = evaluate_gate(
                args.repo_root.resolve(),
                base=base,
                head=head,
                labels=labels,
                skip_reason=skip_reason,
                initial_publication=args.initial_publication,
                registry_version_missing=args.registry_version_missing,
            )
            print(json.dumps(result.as_json(), sort_keys=True))
            return 0
        if args.command == "tarball-digest":
            print(canonical_tarball_digest(args.tarball.resolve()))
            return 0
        if args.command == "verify-tag":
            if args.create:
                resolved = ensure_github_tag(args.repository, args.tag, args.sha)
            else:
                resolved = github_tag_commit(args.repository, args.tag)
                if resolved is None:
                    if not args.allow_missing:
                        raise ReleaseError("GitHub tag is absent")
                    print(json.dumps({"tag": args.tag, "sha": None}, sort_keys=True))
                    return 0
                if resolved != args.sha:
                    raise ReleaseError("GitHub tag points to a different commit")
            print(json.dumps({"tag": args.tag, "sha": resolved}, sort_keys=True))
            return 0
        if args.command == "dist-tag-policy":
            print(dist_tag_action(args.current, args.target))
            return 0
        result = validate_tarball(
            args.tarball.resolve(),
            expected_version=args.version,
            expected_merge_sha=args.merge_sha,
            expected_compatibility=args.compatibility_line,
            require_tag=not args.allow_missing_tag,
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    except ReleaseError as error:
        print(f"release check failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
