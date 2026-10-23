#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)

: "${LOOMHELM_R01_STAGE_DIR:?set LOOMHELM_R01_STAGE_DIR to a new retained candidate directory}"
: "${LOOMHELM_R01_REAL_CLI:?set LOOMHELM_R01_REAL_CLI to the exact bundled CLI executable}"

stage_dir=$LOOMHELM_R01_STAGE_DIR
real_cli=$LOOMHELM_R01_REAL_CLI
case "$stage_dir" in
    /*) ;;
    *) printf 'stage directory must be absolute: %s\n' "$stage_dir" >&2; exit 2 ;;
esac
case "$stage_dir" in
    "$repo_dir"|"$repo_dir"/*)
        printf 'stage directory must be outside the repository: %s\n' "$stage_dir" >&2
        exit 2
        ;;
esac
test -f "$real_cli"
test -x "$real_cli"

cd "$repo_dir"
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
    printf '%s\n' 'refusing to stage from a dirty worktree; commit the reviewed candidate first' >&2
    exit 2
fi

stage_parent=$(dirname -- "$stage_dir")
test -d "$stage_parent"
if [ -e "$stage_dir" ]; then
    printf 'stage directory already exists; choose a new path: %s\n' "$stage_dir" >&2
    exit 2
fi

umask 077
mkdir "$stage_dir"
build_dir=$(mktemp -d /private/tmp/loomhelm-r01-build.XXXXXX)
cleanup() {
    rm -rf "$build_dir"
}
trap cleanup EXIT HUP INT TERM

go test -count=1 ./experiments/codex/stdio_proxy/...
go build -o "$build_dir/stdio-proxy" ./experiments/codex/stdio_proxy/cmd/stdio-proxy
chmod 700 "$build_dir/stdio-proxy"
mv "$build_dir/stdio-proxy" "$stage_dir/stdio-proxy"

source_sha=$(git rev-parse HEAD)
wrapper_sha=$(shasum -a 256 "$stage_dir/stdio-proxy" | awk '{print $1}')
real_cli_sha=$(shasum -a 256 "$real_cli" | awk '{print $1}')
test "$(shasum -a 256 "$stage_dir/stdio-proxy" | awk '{print $1}')" = "$wrapper_sha"
test "$(shasum -a 256 "$real_cli" | awk '{print $1}')" = "$real_cli_sha"
cli_version=$($real_cli --version 2>&1 | head -1)
go_version=$(go version)

printf '%s\n' \
    "source_sha=$source_sha" \
    "wrapper_path=$stage_dir/stdio-proxy" \
    "wrapper_sha256=$wrapper_sha" \
    "real_cli_path=$real_cli" \
    "real_cli_sha256=$real_cli_sha" \
    "real_cli_version=$cli_version" \
    "go_version=$go_version" \
    'target=darwin/arm64' \
    > "$stage_dir/manifest.env"
chmod 600 "$stage_dir/manifest.env"

printf 'stage_dir=%s\n' "$stage_dir"
printf 'manifest=%s\n' "$stage_dir/manifest.env"
printf 'source_sha=%s\n' "$source_sha"
printf 'wrapper_sha256=%s\n' "$wrapper_sha"
printf 'real_cli_sha256=%s\n' "$real_cli_sha"
printf 'real_cli_version=%s\n' "$cli_version"
