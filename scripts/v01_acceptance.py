#!/usr/bin/env python3
"""Create a source- and candidate-bound V01 acceptance evidence ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


SCHEMA_VERSION = 1
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")

CHECKS: Dict[str, Dict[str, str]] = {
    "AC-LH-001": {
        "title": "Web/API/MCP project and task closure",
        "scope": "Cross-project project, task and relationship CRUD with persistence and authorization.",
    },
    "AC-LH-002": {
        "title": "Web navigation and task views",
        "scope": "Workbench, project, conversation and task views in the delivered Web experience.",
    },
    "AC-LH-003": {
        "title": "Independent conversation execution",
        "scope": "A new conversation can execute real work and bind files and task context.",
    },
    "AC-LH-004": {
        "title": "New Codex session control",
        "scope": "Real new Codex session receive, event, approve, deny, interrupt and recovery flow.",
    },
    "AC-LH-005": {
        "title": "Existing Desktop active-session control",
        "scope": "The same active Desktop thread and turn can be attached and controlled.",
    },
    "AC-LH-006": {
        "title": "Durable command and restart closure",
        "scope": "Duplicate commands, concurrent approvals, expiry, ACK loss and three-process restart recovery.",
    },
    "AC-LH-007": {
        "title": "Multi-client draft closure",
        "scope": "Multi-client draft synchronization and conflict behavior.",
    },
    "AC-LH-008": {
        "title": "Artifact authorization and original bytes",
        "scope": "Authorized file metadata and downloads preserve original bytes across restart.",
    },
    "AC-LH-009": {
        "title": "Opaque content and sub-agent compatibility",
        "scope": "Base, unknown and sub-agent content remain lossless and safely exposed.",
    },
    "AC-LH-010": {
        "title": "Responsive and installable PWA",
        "scope": "Desktop/mobile UI, themes, actual PWA installation, offline and update behavior.",
    },
    "AC-LH-011": {
        "title": "Blue-green readiness and handoff",
        "scope": "Candidate identity, readiness, drain, Worker fencing, handoff and recovery.",
    },
    "AC-LH-012": {
        "title": "Full Web/API/MCP product closure",
        "scope": "One real closed loop through Web, API and MCP with source, digest and attempt evidence.",
    },
    "AC-LH-013": {
        "title": "Partial relation failure barriers",
        "scope": "Partial project, task, relation and execution failures stop at explicit durable barriers.",
    },
}


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_absolute(path_value: str, label: str) -> Path:
    path = Path(path_value)
    if not path.is_absolute():
        raise ValueError(f"{label} must be an absolute path: {path_value}")
    return path.resolve()


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def run_git(*arguments: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_root()), *arguments],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "git command failed"
        raise ValueError(detail)
    return result.stdout.strip()


def validate_sha(value: str, label: str = "source SHA") -> str:
    if SHA_RE.fullmatch(value) is None:
        raise ValueError(f"{label} must be a full lowercase 40-character commit SHA")
    return value


def normalize_digest(value: str, label: str = "digest") -> str:
    if DIGEST_RE.fullmatch(value) is None:
        raise ValueError(f"{label} must be a 64-character SHA-256 digest, optionally prefixed with sha256:")
    return value


def redact(value: str) -> str:
    value = re.sub(
        r"(?i)(postgres(?:ql)?://[^\s/:@]+:)[^\s/@]+(@)",
        r"\1<redacted>\2",
        value,
    )
    value = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1<redacted>", value)
    value = re.sub(
        r"(?i)\b(api[_-]?key|authorization|password|secret|token)(\s*[:=]\s*)[^\s,;]+",
        r"\1\2<redacted>",
        value,
    )
    return value


def read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def candidate_manifest(path: Path) -> Dict[str, str]:
    manifest = read_json(path)
    candidate = manifest.get("candidate")
    if isinstance(candidate, dict):
        source_sha = candidate.get("source_sha")
        digest = candidate.get("digest")
        tree_sha = candidate.get("source_tree_sha", "")
    else:
        source_sha = manifest.get("source_sha")
        digest = manifest.get("artifact_digest")
        tree_sha = ""
    if not isinstance(source_sha, str):
        raise ValueError(f"candidate manifest has no candidate.source_sha: {path}")
    if not isinstance(digest, str):
        raise ValueError(f"candidate manifest has no candidate.digest: {path}")
    validate_sha(source_sha, "candidate source SHA")
    normalize_digest(digest, "candidate digest")
    result = {"source_sha": source_sha, "digest": digest}
    if isinstance(tree_sha, str) and tree_sha:
        result["source_tree_sha"] = tree_sha
    return result


def evidence_digest(path: Path) -> Tuple[str, int]:
    if path.is_symlink():
        raise ValueError(f"evidence path must not be a symlink: {path}")
    if path.is_file():
        return sha256_file(path), 1
    if not path.is_dir():
        raise ValueError(f"evidence path does not exist: {path}")
    records: List[str] = []
    file_count = 0
    for child in sorted(path.rglob("*")):
        if child.is_symlink():
            raise ValueError(f"evidence directory contains a symlink: {child}")
        if not child.is_file():
            continue
        relative = child.relative_to(path).as_posix()
        records.append(f"{relative}\0{sha256_file(child)}\0{child.stat().st_size}\n")
        file_count += 1
    return sha256_bytes("".join(records).encode("utf-8")), file_count


def relative_evidence_path(path: Path, evidence_dir: Path) -> str:
    try:
        return path.relative_to(evidence_dir).as_posix()
    except ValueError:
        return str(path)


def atomic_write_json(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=True, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def ledger_path(evidence_dir: Path) -> Path:
    return evidence_dir / "ledger.json"


def load_ledger(evidence_dir: Path) -> Dict[str, Any]:
    path = ledger_path(evidence_dir)
    if not path.is_file():
        raise ValueError(f"ledger does not exist; run init first: {path}")
    ledger = read_json(path)
    if ledger.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"unsupported ledger schema: {ledger.get('schema_version')}")
    if not isinstance(ledger.get("checks"), dict):
        raise ValueError("ledger checks must be an object")
    return ledger


def save_ledger(evidence_dir: Path, ledger: Dict[str, Any]) -> None:
    ledger["updated_at"] = now()
    atomic_write_json(ledger_path(evidence_dir), ledger)


def check_record(ledger: Dict[str, Any], check_id: str) -> Dict[str, Any]:
    if check_id not in CHECKS:
        raise ValueError(f"unknown acceptance check: {check_id}")
    record = ledger["checks"].get(check_id)
    if not isinstance(record, dict):
        raise ValueError(f"ledger is missing check record: {check_id}")
    return record


def current_binding(ledger: Dict[str, Any], source_sha: str, candidate_digest: Optional[str]) -> bool:
    expected_source = ledger["source"]["sha"]
    expected_digest = ledger.get("candidate", {}).get("digest")
    return source_sha == expected_source and candidate_digest is not None and candidate_digest == expected_digest


def init_ledger(args: argparse.Namespace) -> int:
    evidence_dir = ensure_absolute(args.evidence_dir, "evidence directory")
    evidence_dir.mkdir(parents=True, exist_ok=True)
    source_sha = validate_sha(args.source_sha or run_git("rev-parse", "HEAD"))
    head_sha = run_git("rev-parse", "HEAD")
    if head_sha != source_sha:
        raise ValueError(f"HEAD {head_sha} does not match source SHA {source_sha}")
    status = run_git("status", "--porcelain=v1", "--untracked-files=all")
    if status:
        raise ValueError("checkout must be clean before initializing acceptance evidence")
    source_tree_sha = run_git("rev-parse", f"{source_sha}^{{tree}}")
    candidate: Dict[str, Any] = {}
    if args.candidate_manifest:
        manifest_path = ensure_absolute(args.candidate_manifest, "candidate manifest")
        parsed = candidate_manifest(manifest_path)
        if parsed["source_sha"] != source_sha:
            raise ValueError("candidate manifest source SHA does not match the ledger source SHA")
        candidate = {
            **parsed,
            "manifest_path": str(manifest_path),
            "manifest_sha256": sha256_file(manifest_path),
        }
    parent_sha = validate_sha(args.parent_sha, "parent SHA") if args.parent_sha else ""
    existing_path = ledger_path(evidence_dir)
    if existing_path.exists():
        existing = load_ledger(evidence_dir)
        existing_source = existing.get("source", {}).get("sha")
        existing_digest = existing.get("candidate", {}).get("digest")
        if existing_source != source_sha or existing_digest != candidate.get("digest"):
            raise ValueError("existing ledger has a different source or candidate identity")
        print(f"accept-v01: ledger already initialized: {existing_path}")
        return 0
    timestamp = now()
    checks = {
        check_id: {
            "id": check_id,
            "title": details["title"],
            "scope": details["scope"],
            "status": "not_run",
            "current_candidate_proof": False,
            "attempts": [],
            "evidence": [],
            "decisions": [],
            "updated_at": timestamp,
        }
        for check_id, details in CHECKS.items()
    }
    ledger: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "created_at": timestamp,
        "updated_at": timestamp,
        "repository": {
            "root": str(repo_root()),
            "branch": run_git("branch", "--show-current"),
        },
        "source": {
            "sha": source_sha,
            "tree_sha": source_tree_sha,
            "parent_branch": args.parent_branch or "",
            "parent_sha": parent_sha,
            "clean": True,
        },
        "candidate": candidate,
        "attempt_sequence": 0,
        "checks": checks,
        "notes": [
            "A passed check proves only the command or evidence recorded for this ledger.",
            "A reused check is not a current acceptance pass unless a separate owner decision says so.",
            "AC-LH-005 and actual PWA installation must remain unpassed without their real external evidence.",
        ],
    }
    atomic_write_json(existing_path, ledger)
    print(f"accept-v01: initialized {existing_path}")
    return 0


def process_group_terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        if hasattr(os, "killpg"):
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            if hasattr(os, "killpg"):
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass


def output_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def run_check(args: argparse.Namespace) -> int:
    evidence_dir = ensure_absolute(args.evidence_dir, "evidence directory")
    ledger = load_ledger(evidence_dir)
    record = check_record(ledger, args.check_id)
    existing_pass = any(
        attempt.get("status") == "passed"
        and attempt.get("source_sha") == ledger["source"]["sha"]
        and attempt.get("candidate_digest") == ledger.get("candidate", {}).get("digest")
        for attempt in record.get("attempts", [])
    )
    if existing_pass and not args.allow_repeat:
        print(f"accept-v01: reusing existing passed attempt for {args.check_id}")
        return 0
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise ValueError("run requires a command after --")
    try:
        timeout = float(args.timeout)
    except ValueError as error:
        raise ValueError(f"invalid timeout: {args.timeout}") from error
    if timeout <= 0:
        raise ValueError("timeout must be greater than zero")
    attempts_dir = evidence_dir / "attempts"
    attempts_dir.mkdir(parents=True, exist_ok=True)
    attempt_number = int(ledger.get("attempt_sequence", 0)) + 1
    ledger["attempt_sequence"] = attempt_number
    attempt_id = f"attempt-{attempt_number:04d}"
    started_at = now()
    started_clock = time.monotonic()
    process: Optional[subprocess.Popen[str]] = None
    stdout = ""
    stderr = ""
    timed_out = False
    exit_code: Optional[int] = None
    try:
        process = subprocess.Popen(
            command,
            cwd=str(repo_root()),
            env=os.environ.copy(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            timed_out = True
            stdout = output_text(error.stdout)
            stderr = output_text(error.stderr)
            process_group_terminate(process)
            remaining_stdout, remaining_stderr = process.communicate()
            stdout += output_text(remaining_stdout)
            stderr += output_text(remaining_stderr)
        exit_code = process.returncode
    except OSError as error:
        stderr = f"accept-v01: could not execute command: {error}\n"
        exit_code = 127
    duration = round(time.monotonic() - started_clock, 3)
    redacted_stdout = redact(stdout)
    redacted_stderr = redact(stderr)
    stdout_path = attempts_dir / f"{attempt_id}.stdout.log"
    stderr_path = attempts_dir / f"{attempt_id}.stderr.log"
    stdout_path.write_text(redacted_stdout, encoding="utf-8")
    stderr_path.write_text(redacted_stderr, encoding="utf-8")
    status = "passed" if exit_code == 0 and not timed_out else "failed"
    attempt: Dict[str, Any] = {
        "id": attempt_id,
        "name": args.name,
        "status": status,
        "started_at": started_at,
        "duration_seconds": duration,
        "timeout_seconds": timeout,
        "timed_out": timed_out,
        "exit_code": exit_code,
        "command": [redact(part) for part in command],
        "source_sha": ledger["source"]["sha"],
        "candidate_digest": ledger.get("candidate", {}).get("digest"),
        "stdout_log": relative_evidence_path(stdout_path, evidence_dir),
        "stderr_log": relative_evidence_path(stderr_path, evidence_dir),
        "stdout_sha256": sha256_file(stdout_path),
        "stderr_sha256": sha256_file(stderr_path),
        "stdout_bytes": stdout_path.stat().st_size,
        "stderr_bytes": stderr_path.stat().st_size,
        "current_candidate_proof": status == "passed" and current_binding(
            ledger, ledger["source"]["sha"], ledger.get("candidate", {}).get("digest")
        ),
    }
    record.setdefault("attempts", []).append(attempt)
    record["status"] = status
    record["current_candidate_proof"] = attempt["current_candidate_proof"]
    record["updated_at"] = now()
    save_ledger(evidence_dir, ledger)
    print(
        f"accept-v01: {args.check_id} {status} exit={exit_code} duration={duration}s "
        f"stdout={relative_evidence_path(stdout_path, evidence_dir)}"
    )
    return 0 if status == "passed" else 1


def append_evidence(record: Dict[str, Any], item: Dict[str, Any]) -> bool:
    for existing in record.get("evidence", []):
        if (
            existing.get("path") == item.get("path")
            and existing.get("sha256") == item.get("sha256")
            and existing.get("source_sha") == item.get("source_sha")
            and existing.get("candidate_digest") == item.get("candidate_digest")
        ):
            return False
    record.setdefault("evidence", []).append(item)
    return True


def reuse_evidence(args: argparse.Namespace) -> int:
    evidence_dir = ensure_absolute(args.evidence_dir, "evidence directory")
    ledger = load_ledger(evidence_dir)
    record = check_record(ledger, args.check_id)
    path = ensure_absolute(args.evidence, "evidence path")
    digest, file_count = evidence_digest(path)
    source_sha = validate_sha(args.evidence_source_sha or ledger["source"]["sha"], "evidence source SHA")
    candidate_digest = args.evidence_candidate_digest or ""
    if candidate_digest:
        normalize_digest(candidate_digest, "evidence candidate digest")
    item: Dict[str, Any] = {
        "path": str(path),
        "sha256": digest,
        "file_count": file_count,
        "source_sha": source_sha,
        "candidate_digest": candidate_digest or None,
        "status": args.status,
        "reason": args.reason,
        "current_candidate_proof": args.status == "passed"
        and current_binding(ledger, source_sha, candidate_digest or None),
        "recorded_at": now(),
    }
    added = append_evidence(record, item)
    if added:
        record["status"] = args.status
        record["current_candidate_proof"] = item["current_candidate_proof"]
        record["updated_at"] = now()
        save_ledger(evidence_dir, ledger)
        print(f"accept-v01: recorded {args.status} evidence for {args.check_id}: {path}")
    else:
        print(f"accept-v01: evidence already recorded for {args.check_id}: {path}")
    return 0


def mark_check(args: argparse.Namespace) -> int:
    evidence_dir = ensure_absolute(args.evidence_dir, "evidence directory")
    ledger = load_ledger(evidence_dir)
    record = check_record(ledger, args.check_id)
    decision: Dict[str, Any] = {"status": args.status, "reason": args.reason, "recorded_at": now()}
    record.setdefault("decisions", []).append(decision)
    record["status"] = args.status
    record["current_candidate_proof"] = False
    record["updated_at"] = now()
    save_ledger(evidence_dir, ledger)
    print(f"accept-v01: marked {args.check_id} {args.status}: {args.reason}")
    return 0


def status_label(record: Dict[str, Any]) -> str:
    status = record.get("status", "not_run")
    if status == "passed" and record.get("current_candidate_proof"):
        return "passed/current"
    if status == "passed":
        return "passed/unbound"
    return str(status)


def render_markdown(ledger: Dict[str, Any]) -> str:
    source = ledger["source"]
    candidate = ledger.get("candidate", {})
    lines = [
        "# V01 Loomhelm Joint Acceptance",
        "",
        "This report is an evidence ledger, not a declaration that the phase-one product has passed.",
        "",
        f"- Source SHA: `{source['sha']}`",
        f"- Source tree SHA: `{source['tree_sha']}`",
        f"- Parent branch: `{source.get('parent_branch') or 'unspecified'}`",
        f"- Parent SHA: `{source.get('parent_sha') or 'unspecified'}`",
        f"- Candidate digest: `{candidate.get('digest') or 'not recorded'}`",
        f"- Candidate manifest: `{candidate.get('manifest_path') or 'not recorded'}`",
        "",
        "| Check | Status | Current candidate proof | Evidence or decision |",
        "| --- | --- | --- | --- |",
    ]
    for check_id, details in CHECKS.items():
        record = ledger["checks"][check_id]
        evidence = list(record.get("evidence", []))
        attempts = list(record.get("attempts", []))
        decisions = list(record.get("decisions", []))
        details_text: List[str] = []
        for item in evidence:
            details_text.append(f"{item.get('status')}: {item.get('path')}")
        for attempt in attempts:
            details_text.append(f"{attempt.get('status')}: {attempt.get('stdout_log')}")
        for decision in decisions:
            details_text.append(f"{decision.get('status')}: {decision.get('reason')}")
        evidence_text = "<br>".join(details_text) or "none"
        evidence_text = evidence_text.replace("|", "\\|")
        lines.append(
            f"| `{check_id}` {details['title']} | `{status_label(record)}` | "
            f"`{'yes' if record.get('current_candidate_proof') else 'no'}` | {evidence_text} |"
        )
    lines.extend(
        [
            "",
            "## Boundaries",
            "",
            "A `reused` record is historical evidence and does not prove the current candidate.",
            "AC-LH-005 requires the same active Desktop thread and turn; history, fork, copy or another app-server process does not satisfy it.",
            "Actual PWA installation and runtime blue-green behavior remain unpassed unless their real evidence is recorded for this source and candidate.",
            "",
        ]
    )
    return "\n".join(lines)


def report(args: argparse.Namespace) -> int:
    evidence_dir = ensure_absolute(args.evidence_dir, "evidence directory")
    ledger = load_ledger(evidence_dir)
    if args.format == "json":
        output = json.dumps(ledger, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
    else:
        output = render_markdown(ledger)
    if args.output:
        output_path = ensure_absolute(args.output, "report output")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output, encoding="utf-8")
        print(f"accept-v01: wrote {output_path}")
    else:
        sys.stdout.write(output)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="initialize a clean source/candidate ledger")
    init.add_argument("--evidence-dir", required=True)
    init.add_argument("--source-sha")
    init.add_argument("--parent-branch", default="")
    init.add_argument("--parent-sha", default="")
    init.add_argument("--candidate-manifest")
    init.set_defaults(handler=init_ledger)

    run = subparsers.add_parser("run", help="run one bounded command and record redacted logs")
    run.add_argument("--evidence-dir", required=True)
    run.add_argument("--check-id", required=True, choices=tuple(CHECKS))
    run.add_argument("--name", required=True)
    run.add_argument("--timeout", default="900")
    run.add_argument("--allow-repeat", action="store_true")
    run.add_argument("command", nargs=argparse.REMAINDER)
    run.set_defaults(handler=run_check)

    reuse = subparsers.add_parser("reuse", help="record existing evidence without rerunning it")
    reuse.add_argument("--evidence-dir", required=True)
    reuse.add_argument("--check-id", required=True, choices=tuple(CHECKS))
    reuse.add_argument("--status", choices=("passed", "reused"), default="reused")
    reuse.add_argument("--evidence", required=True)
    reuse.add_argument("--evidence-source-sha")
    reuse.add_argument("--evidence-candidate-digest")
    reuse.add_argument("--reason", required=True)
    reuse.set_defaults(handler=reuse_evidence)

    mark = subparsers.add_parser("mark", help="record an explicit blocked or not-run decision")
    mark.add_argument("--evidence-dir", required=True)
    mark.add_argument("--check-id", required=True, choices=tuple(CHECKS))
    mark.add_argument("--status", required=True, choices=("blocked", "not_run"))
    mark.add_argument("--reason", required=True)
    mark.set_defaults(handler=mark_check)

    report_parser = subparsers.add_parser("report", help="render the JSON or Markdown ledger")
    report_parser.add_argument("--evidence-dir", required=True)
    report_parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    report_parser.add_argument("--output")
    report_parser.set_defaults(handler=report)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except (OSError, ValueError) as error:
        print(f"accept-v01: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
