# Ivan Rust crate release style (crates.io)

## Release tags

- Tag format: `release/<semver>` (example: `release/x.y.z`).

## GitHub Actions release workflow (pattern)

- Trigger: `workflow_dispatch` with input `version` (`major|minor|patch` or semver), default `patch`.
- Concurrency group: `release-crate`.
- Publish step: `kaleidawave/crates-release-gh-action@main`
  - `with.version`: `${{ github.event.inputs.version }}`
  - `with.crates-token`: `${{ secrets.CARGO_REGISTRY_TOKEN }}`
- Git steps (after publish):
  - `git add .`
  - `git commit -m "Release: ${{ steps.release.outputs.new-versions-description }}"`
  - `git tag "release/${{ steps.release.outputs.new-version }}"`
  - `git push --tags origin main`

Recommended hardening:

- Add `permissions: { contents: write }` if the repo’s default `GITHUB_TOKEN` permissions are read-only.

## CI gate style (example: stricter crate)

- Install toolchain via `dtolnay/rust-toolchain@stable` with `rustfmt` + `clippy`.
- Run `cargo fmt --all -- --check`.
- Run `cargo clippy --all-targets ... -- -D warnings`.
- Build + test.
- If the crate has important feature combinations, use a matrix. For embedded driver crates, always include **sync** (default, no features) and **async** (`--features async`). Example set observed in practice:
  - `""`, `"async"`, `"defmt"`, `"async,defmt"`

If the repo contains example firmware/projects (e.g. under `examples/*`), consider building them as a separate job and (if needed) install `thumbv7em-none-eabihf` targets.
