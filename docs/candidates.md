# Candidate Builds

The candidate contract builds Server, Worker, Connector and Web static assets from one exact, clean Git source SHA. The default target is `linux/amd64`; use `--goos` and `--goarch` only when the target platform is part of the candidate identity.

The builder records the source commit and tree SHA, source commit timestamp, target platform, pinned Go and Bun versions, fixed build environment, lockfile and build-input digests, every component file digest and mode, the complete Web file list, and a deterministic `candidate.tar.gz`. `candidate-manifest.json.sha256` and `candidate.tar.gz.sha256` protect the manifest and package bytes separately.

The candidate identity is the SHA256 digest of the canonical manifest identity, excluding the manifest's own digest and the package archive digest. This avoids a circular hash while keeping the source SHA, build inputs and output bytes bound to one `candidate_digest`; promotion also validates that the archive members and bytes exactly match the manifest files.

## Local Build

Run the builder from a clean checkout whose `HEAD` is the exact source SHA:

```sh
source_sha=$(git rev-parse HEAD)
scripts/build-candidate --source-sha "$source_sha" --output /tmp/loomhelm-candidate
```

The command rejects abbreviated or unknown SHAs, dirty tracked or untracked files, source-tree symlinks, tool versions that differ from `tools/versions.env`, existing output directories, symlinked or non-regular Web output entries, and unsupported target names. It builds from a temporary detached worktree for the exact commit, fixes the Web build environment, re-runs the complete promotion verifier before publication, and never overwrites an existing candidate.

Inspect the identity without parsing build logs:

```sh
python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["candidate"])' /tmp/loomhelm-candidate/candidate-manifest.json
```

## Reproduction

Build the same source SHA twice and compare the complete manifest and deterministic package digest:

```sh
scripts/reproduce-candidate --source-sha "$source_sha"
```

The reproduction command intentionally performs two builds and removes its temporary output after the comparison. A retry of promotion or release must use the already-uploaded candidate artifact instead of invoking this command or `scripts/build-candidate` again.

## Promotion

Promotion verifies the source commit and tree against the trusted checkout, the complete build input/toolchain contract, all manifest records, fixed executable/Web modes, the component and Web bytes, the deterministic archive structure, both sidecars, and the candidate identity digest before copying. It copies into a temporary directory with directory-descriptor-relative operations, fixes destination modes independently of umask, re-verifies that copy, rejects symlink components, removes stale same-digest temporary directories after interrupted runs, uses an atomic same-directory no-replace rename, and serializes same-digest retries with an OS lock that is released after process death. The destination is keyed by `candidate_digest`, so the same candidate is idempotent and a conflicting directory fails closed:

```sh
scripts/promote-candidate \
  --manifest /tmp/loomhelm-candidate/candidate-manifest.json \
  --destination /tmp/loomhelm-preview \
  --expected-digest "$candidate_digest" \
  --expected-source-sha "$source_sha"
```

The promotion script has no Go, Bun, Docker or package-install command. The current implementation publishes an immutable handoff directory; HTTP slot readiness, traffic switching, Worker fencing and production deployment remain separate deployment work.

## Workflow Gates

`Candidate CI` runs on PR, merge-queue and manual candidate events with a PR-cancellable but merge-queue-stable concurrency group. Its required checks are `Quality Gates`, `Repository Verification`, and `Candidate Build`; `Candidate Reproducibility` is informational, allowed to fail without changing the workflow's success conclusion, and repeats the build identity check.

`Branch Preview` uses a non-cancellable per-branch group, requires the workflow ref and source SHA to belong to `feat/phase1` history, builds once, uploads the candidate, and promotes that exact artifact into the `branch-preview` environment. `Release Candidate` uses a non-cancellable candidate-specific environment group, accepts only a successful manual `Candidate CI` run from the repository's `feat/phase1` branch with a successful `Candidate Build` job, exact source/digest-bound artifact name, matching head SHA, and trusted repository identity, checks out full-history trusted tooling from `feat/phase1`, and downloads/promotes the existing artifact without rebuilding it. The release workflow is intentionally restricted to that protected branch; pull-request, merge-queue and fork runs cannot cross this release boundary.

The checked-in merge/release declaration is [.github/quality-gates.json](../.github/quality-gates.json). GitHub branch protection and environment approval settings remain external execution state and must be aligned with that declaration by the repository owner.
