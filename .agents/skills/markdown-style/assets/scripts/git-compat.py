#!/usr/bin/env python3
"""Preserve native Git behavior while disambiguating Lefthook's diff output."""

import os
import sys

native = os.environ.get("MARKDOWN_STYLE_NATIVE_GIT")
if not native:
    raise SystemExit("Markdown Git compatibility entry requires the managed Lefthook wrapper")

arguments = sys.argv[1:]
if arguments[:1] == ["diff"]:
    boundary = arguments.index("--") if "--" in arguments else len(arguments)
    for index in range(1, boundary - 1):
        if arguments[index] == "--output":
            # Git's early no-index detection mistakes a separate outside path
            # plus trailing -- for two comparison paths. Joined syntax is
            # equivalent and cannot be mistaken for a positional argument.
            arguments[index:index + 2] = ["--output=" + arguments[index + 1]]
            break

os.execv(native, [native, *arguments])
