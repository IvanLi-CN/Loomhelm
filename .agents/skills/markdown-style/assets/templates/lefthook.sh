#!/bin/sh
set -eu
export GIT_LITERAL_PATHSPECS=1

exec python3 tools/markdown.py --lefthook "$@"
