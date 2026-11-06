#!/usr/bin/env python3
"""Run pinned native Markdown tools; requires only Python's standard library."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ASSETS = Path(__file__).resolve().parents[1]
MANIFEST = ASSETS / "toolchain.json"
CACHE = Path(".tmp/markdown-tools")
HOOK_MARKER = "# markdown-style-managed-hook"
GIT_COMPAT = ASSETS / "scripts/git-compat.py"


class ToolError(Exception):
    """An actionable toolchain, configuration, or Git error."""


def git(root: Path, *arguments: str) -> bytes:
    result = subprocess.run(["git", *arguments], cwd=root, capture_output=True)
    if result.returncode:
        raise ToolError(result.stderr.decode(errors="replace").strip())
    return result.stdout


def repository_root() -> Path:
    return Path(os.fsdecode(git(Path.cwd(), "rev-parse", "--show-toplevel")).strip()).resolve()


def platform_key() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    architecture = {"aarch64": "arm64", "arm64": "arm64", "amd64": "x86_64", "x86_64": "x86_64"}.get(machine)
    if system not in {"darwin", "linux"} or architecture is None:
        raise ToolError(f"Unsupported native tool platform: {system}/{machine}")
    return f"{system}-{architecture}"


def manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def matches(path: Path, expected: str) -> bool:
    return path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected


def resources(root: Path) -> list[tuple[Path, dict, bool]]:
    data = manifest()
    key = platform_key()
    return [
        (root / CACHE / "dprint", data["dprint"]["platforms"][key], True),
        (root / CACHE / "lefthook", data["lefthook"]["platforms"][key], True),
        (root / CACHE / data["markdown"]["filename"], data["markdown"], False),
    ]


def expected_hash(resource: dict) -> str:
    return resource.get("binary_sha256", resource["sha256"])


def download(resource: dict) -> bytes:
    with urllib.request.urlopen(resource["url"], timeout=30) as response:
        archive = response.read()
    if digest(archive) != resource["sha256"]:
        raise ToolError("Official download SHA256 mismatch; no tool was installed")
    if resource.get("format") == "zip":
        # Read only the declared member, never extract archive paths to disk.
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            data = bundle.read(resource["member"])
    else:
        data = archive
    if digest(data) != expected_hash(resource):
        raise ToolError("Native binary SHA256 mismatch; no tool was installed")
    return data


def setup(root: Path) -> None:
    cache = root / CACHE
    if (root / ".tmp").is_symlink() or cache.is_symlink():
        raise ToolError("Tool cache must be a repository-local regular directory")
    ignored = subprocess.run(["git", "check-ignore", "-q", "--", str(CACHE / "probe")], cwd=root)
    if ignored.returncode != 0:
        raise ToolError("Ignore /.tmp/markdown-tools/ in .gitignore before preparing native tools")
    cache.mkdir(parents=True, exist_ok=True)
    for target, resource, executable in resources(root):
        if not matches(target, expected_hash(resource)):
            data = download(resource)
            with tempfile.NamedTemporaryFile(dir=cache, delete=False) as handle:
                temporary = Path(handle.name)
                try:
                    handle.write(data)
                    handle.flush()
                    temporary.chmod(0o755 if executable else 0o644)
                    temporary.replace(target)
                finally:
                    temporary.unlink(missing_ok=True)
        elif executable and not os.access(target, os.X_OK):
            target.chmod(0o755)
    compatibility = git_compat_path(root)
    compatibility.parent.mkdir(exist_ok=True)
    code = GIT_COMPAT.read_bytes()
    if not matches(compatibility, digest(code)):
        with tempfile.NamedTemporaryFile(dir=compatibility.parent, delete=False) as handle:
            temporary = Path(handle.name)
            try:
                handle.write(code)
                handle.flush()
                temporary.chmod(0o755)
                temporary.replace(compatibility)
            finally:
                temporary.unlink(missing_ok=True)
    elif not os.access(compatibility, os.X_OK):
        compatibility.chmod(0o755)
    validate_config(root)
    # Compilation is initialization work; the local Wasm cannot trigger a download.
    result = subprocess.run(
        [str(cache / "dprint"), "fmt", "--config", str(root / "dprint.json"),
         "--config-discovery=false", "--stdin", "bootstrap.md"],
        input=b"", cwd=root,
    )
    if result.returncode:
        raise ToolError("Cannot initialize Markdown formatter; check dprint.json")
    print("Pinned Markdown tools are ready.")


def ready(root: Path) -> None:
    if (root / ".tmp").is_symlink() or (root / CACHE).is_symlink():
        raise ToolError("Tool cache must be a repository-local regular directory")
    for target, resource, executable in resources(root):
        if not matches(target, expected_hash(resource)) or (executable and not os.access(target, os.X_OK)):
            raise ToolError("Pinned Markdown tools are missing or changed. Run: python3 tools/markdown.py setup")


def validate_config(root: Path) -> None:
    config_path = root / "dprint.json"
    if config_path.is_symlink():
        raise ToolError("dprint.json must be a regular repository configuration")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    expected = root / CACHE / manifest()["markdown"]["filename"]
    plugins = config.get("plugins", [])
    if len(plugins) != 1 or not isinstance(plugins[0], str) or (root / plugins[0]).resolve() != expected.resolve() or config.get("extends"):
        raise ToolError("dprint.json must use only the pinned local Markdown Wasm, without config extensions")


def install_hooks(root: Path) -> None:
    configured = subprocess.run(["git", "config", "--get", "core.hooksPath"], cwd=root, capture_output=True)
    if configured.returncode == 0:
        raise ToolError("Existing core.hooksPath is preserved; integrate the Markdown command with that hook manager")
    hook = Path(os.fsdecode(git(root, "rev-parse", "--git-path", "hooks/pre-commit")).strip())
    if not hook.is_absolute():
        hook = root / hook
    if hook.is_symlink():
        raise ToolError("Existing pre-commit symlink is preserved; integrate the Markdown command manually")
    if hook.exists():
        if HOOK_MARKER in hook.read_text(encoding="utf-8"):
            print("Repository Markdown hook is already installed.")
            return
        raise ToolError("Existing pre-commit hook is preserved; integrate the Markdown command manually")
    if not (root / "lefthook.yml").is_file():
        raise ToolError("Add the reviewed lefthook.yml before installing hooks")
    ready(root)
    result = subprocess.run([str(root / CACHE / "lefthook"), "install", "pre-commit"], cwd=root)
    if result.returncode:
        raise ToolError("Lefthook installation failed; existing hooks were not forcibly replaced")
    with hook.open("a", encoding="utf-8") as handle:
        handle.write(f"\n{HOOK_MARKER}\n")


def selected_files(root: Path, staged: bool) -> list[str]:
    if staged:
        output = git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z")
    else:
        output = git(root, "ls-files", "--cached", "-z")
    selected: list[str] = []
    for encoded in dict.fromkeys(output.split(b"\0")):
        name = os.fsdecode(encoded)
        if not name.endswith(".md"):
            continue
        if "\\" in name:
            raise ToolError(f"dprint treats backslashes as path separators; rename this file before formatting: {name}")
        path = root / name
        if path.is_symlink() or path.resolve() != path:
            raise ToolError(f"Markdown symlink is preserved; use a regular tracked file: {name}")
        if path.is_file():
            selected.append(name)
    return selected


def format_files(root: Path, command: str) -> int:
    files = selected_files(root, staged=command == "staged")
    if not files:
        print("No selected Markdown files; skipping.")
        return 0
    ready(root)
    validate_config(root)
    operation = "check" if command == "check" else "fmt"
    base = [str(root / CACHE / "dprint"), operation, "--config", str(root / "dprint.json"),
            "--config-discovery=false", "--no-gitignore", "--"]
    # Keep every batch below native argv limits, even in larger consumer repos.
    batches: list[list[str]] = [[]]
    size = 0
    for name in files:
        # dprint's escape_glob_text_for_cli uses character classes, because
        # CLI backslashes become separators. Anchor even plain basenames.
        pattern = "./" + "".join(f"[{char}]" if char in "[]{}*?" else char for char in name)
        length = len(os.fsencode(pattern)) + 1
        if size + length > 65536 and batches[-1]:
            batches.append([])
            size = 0
        batches[-1].append(pattern)
        size += length
    status = 0
    for batch in batches:
        result = subprocess.run([*base, *batch], cwd=root)
        if result.returncode:
            status = result.returncode
            if operation != "check":
                break
    if status:
        print("Markdown validation failed. Run: python3 tools/markdown.py fix", file=sys.stderr)
    return status


@contextmanager
def pre_commit_lock(root: Path):
    """Keep shared native recovery files private to one hook transaction."""
    info = Path(os.fsdecode(git(root, "rev-parse", "--path-format=absolute", "--git-path", "info")).rstrip("\n"))
    info.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(info / "markdown-style.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ToolError("Markdown hook lock must be a regular Git metadata file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ToolError("Another Markdown pre-commit is running in this repository or a linked worktree; retry after it finishes") from None
        yield info, descriptor
    finally:
        # Closing also releases the advisory lock after exceptions or exit.
        os.close(descriptor)


def git_compat_path(root: Path) -> Path:
    directory = root / CACHE / "git-compat"
    if directory.is_symlink():
        raise ToolError("Git compatibility cache must be a regular repository-local directory")
    return directory / "git"


def run_lefthook(root: Path, target: Path, arguments: list[str], lock_descriptor: int | None = None) -> int:
    compatibility = git_compat_path(root)
    if not matches(compatibility, digest(GIT_COMPAT.read_bytes())) or not os.access(compatibility, os.X_OK):
        raise ToolError("Markdown Git compatibility entry is missing or changed. Run: python3 tools/markdown.py setup")
    native_git = shutil.which("git")
    if native_git is None or Path(native_git).resolve() == compatibility.resolve():
        raise ToolError("Cannot locate native Git outside the Markdown compatibility entry")
    environment = dict(os.environ)
    environment["MARKDOWN_STYLE_NATIVE_GIT"] = native_git
    environment["PATH"] = str(compatibility.parent) + os.pathsep + environment.get("PATH", "")
    # The native runner retains the same open-file lock if its Python parent
    # exits early; closing our descriptor must not unlock a still-live runner.
    inherited = () if lock_descriptor is None else (lock_descriptor,)
    return subprocess.run([str(target), *arguments], cwd=root, env=environment, pass_fds=inherited).returncode


def lefthook_command(arguments: list[str]) -> int:
    """Invoke the pinned hook runner without consuming earlier recovery data."""
    try:
        root = repository_root()
        if (root / ".tmp").is_symlink() or (root / CACHE).is_symlink():
            raise ToolError("Tool cache must be a repository-local regular directory")
        target, resource, _ = resources(root)[1]
        if not matches(target, expected_hash(resource)) or not os.access(target, os.X_OK):
            raise ToolError("Pinned Lefthook is missing or changed. Run: python3 tools/markdown.py setup")
        if arguments and arguments[0] == "run" and "pre-commit" in arguments:
            with pre_commit_lock(root) as (info, lock_descriptor):
                # Native Lefthook drops backups by this message prefix and overwrites
                # these fixed patch paths. Earlier failed-hook recovery is not ours.
                backups = git(root, "stash", "list", "--format=%gs").splitlines()
                patches = [info / name for name in ("lefthook-unstaged.patch", "lefthook-unstaged-all.patch")]
                if any(message.startswith(b"lefthook auto backup") for message in backups) or any(path.exists() or path.is_symlink() for path in patches):
                    raise ToolError(
                        "Existing Lefthook recovery data is preserved; commit stopped. "
                        "Inspect git stash list and git rev-parse --git-path info; "
                        "save or recover the lefthook auto backup / lefthook-unstaged*.patch "
                        "before explicitly clearing those recovery entries."
                    )
                return run_lefthook(root, target, arguments, lock_descriptor)
        return run_lefthook(root, target, arguments)
    except (ToolError, OSError, ValueError) as error:
        print(f"Markdown tools: {error}", file=sys.stderr)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "check", "fix", "staged"))
    parser.add_argument("--install-hooks", action="store_true")
    # Lefthook needs {files} metadata to re-stage type changes. Selection still
    # comes from Git's NUL output, never from the shell-expanded metadata.
    parser.add_argument("hook_files", nargs="*", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.install_hooks and args.command != "setup":
        parser.error("--install-hooks is only valid with setup")
    if args.hook_files and args.command != "staged":
        parser.error("hook file metadata is only valid with staged")
    try:
        root = repository_root()
        if args.command == "setup":
            setup(root)
            if args.install_hooks:
                install_hooks(root)
            return 0
        return format_files(root, args.command)
    except (ToolError, OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"Markdown tools: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
