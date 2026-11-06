# Cargo package checklist (publishable crate)

Use this checklist before the first publish and before every release.

## Cargo.toml `[package]` essentials

- `name`, `version`
- Rust edition: use the latest stable Rust edition.
- `license = "MIT OR Apache-2.0"`
- `description`
- `repository`
- `keywords` (optional but recommended)
- `categories` (optional but recommended)
- `documentation = "https://docs.rs/<crate-name>"` (optional but recommended)
- `readme = "README.md"` (optional but recommended)
- `rust-version = "<msrv>"` (optional; set when MSRV matters)

## Licensing consistency

- Ensure the repo contains license text matching `license`.
  - If using dual license (`MIT OR Apache-2.0`), include both license texts (separate files or a combined file), and keep README/license statements consistent.

## Keep crates.io package small

Prefer a conservative `[package].exclude` list that omits build artifacts and repo-only files.

Example-style exclude list (observed in existing crates):

```toml
exclude = [
    "docs",
    "target/",
    ".vscode/",
    ".github/",
    "lefthook.yml",
    "scripts/"
]
```

Adjust for your repo:

- Exclude `examples/*/target/` if examples build inside their own target dirs.
- Exclude large binary assets under `docs/` (e.g. PDFs, screenshots) if not needed on crates.io.

## Preflight checks (recommended)

- `cargo fmt --all`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- `cargo package` (ensures the packaged crate contains the right files)

If CI is configured, ensure it’s green on `main` before releasing.
