---
name: rust-crate-release
description: "Set up and run Rust crate releases."
---

# Rust Crate Release

## Overview

Use this skill to implement Ivan’s default crates.io publishing workflow (CI + manual GitHub Actions release), and to run releases safely (version bump, tag, push, publish).

## Guardrails

- **No guessing:** confirm crate/workspace structure, default branch (usually `main`), and whether `main` is protected.
- **No file writes without explicit OK (in the target repo):** propose a plan + file list, then wait.
- **No publishing without explicit OK:** never publish to crates.io or push tags without confirmation.
- **Toolchain policy:** default is latest stable; if local toolchain is not latest and an update is needed, ask before any `rustup` change.
- **Version policy:** default to latest stable versions; treat any versions observed in Ivan repos as minimum acceptable; do not pin versions unless required, and ask when pinning (MSRV, compatibility, security) matters.

## Workflow

### 1) Inventory + confirm intent

Collect:

- crate(s) to publish (single crate vs workspace)
- current version(s), features, MSRV (`rust-version`)
- current CI gates (fmt/clippy/test/build) and existing release process
- if this is an embedded driver crate: confirm the async+sync support plan (typically `async` feature + `maybe-async-cfg`)

Confirm:

- publish target is crates.io
- release tag format is `release/<semver>`
- release runs from `main`

### 2) Make the crate publishable (Cargo metadata + package hygiene)

Use `references/cargo-package-checklist.md` for the exact checklist.

Defaults observed in Ivan’s published crates:

- Rust edition: use latest stable Rust edition.
- `license = "MIT OR Apache-2.0"`
- `exclude = [...]` to keep crates.io uploads small (typically exclude `target/`, `.github/`, `scripts/`, editor configs, generated assets)

### 3) Add CI quality gates (recommended)

Create/adjust `.github/workflows/build.yml` (template provided).

Baseline gates:

- `cargo fmt --all -- --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo build`
- `cargo test`

If the crate has important feature combos, add a matrix like in `references/release-style.md`.

### 4) Add GitHub Actions release workflow (Ivan default)

Create/adjust `.github/workflows/release.yml` (template provided).

Behavior:

- Manual trigger via `workflow_dispatch`, with an input `version` (`major|minor|patch` or semver)
- Publish via `kaleidawave/crates-release-gh-action@main` using `secrets.CARGO_REGISTRY_TOKEN`
- Commit updated `Cargo.toml`, tag `release/<new-version>`, and push `main` + tags

Notes:

- If the repo uses commitlint/conventional commits, adjust the release commit message accordingly (e.g. `chore(release): ...`).
- If `main` is protected and Actions cannot push, stop and ask the user which workaround to adopt (settings vs PR-based release).

### 5) Run a release (operator runbook)

Before triggering release:

- Ensure CI is green on `main`.
- Ensure `CARGO_REGISTRY_TOKEN` is configured in repo secrets.
- Confirm the version bump input (`patch` by default).

Trigger the workflow, then verify:

- tag `release/<semver>` exists in the repo
- crates.io shows the new version

## Templates

- Release workflow: `templates/workflows/release.yml`
- CI workflow: `templates/workflows/build.yml`

## References (load only when needed)

- Ivan’s release conventions (evidence + matrices): `references/release-style.md`
- Cargo packaging checklist (Cargo.toml keys, license, exclude): `references/cargo-package-checklist.md`
