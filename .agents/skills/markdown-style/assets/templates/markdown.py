#!/usr/bin/env python3
"""Delegate to the source or project-installed Markdown style Policy."""

from pathlib import Path
import runpy
import sys

root = Path(__file__).resolve().parents[1]
for package in (root / "skills/policies/markdown-style", root / ".agents/skills/markdown-style"):
    script = package / "assets/scripts/markdown.py"
    if script.is_file():
        entry = runpy.run_path(str(script))
        if sys.argv[1:2] == ["--lefthook"]:
            raise SystemExit(entry["lefthook_command"](sys.argv[2:]))
        raise SystemExit(entry["main"]())
raise SystemExit("Markdown style Policy is missing; install or restore the reviewed package.")
