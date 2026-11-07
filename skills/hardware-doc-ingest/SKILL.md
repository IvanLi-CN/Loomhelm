---
name: hardware-doc-ingest
description: "Ingest hardware PDFs into project docs."
---

# Hardware Doc Ingest

## Overview

Ingest vendor PDFs into a repo so the project has a durable, searchable Markdown copy (with local images), while still keeping the original PDF for fidelity.

## Guardrails

- Confirm whether the repo is public; do not commit redistributed vendor PDFs into public repos unless the user explicitly approves.
- Avoid overwriting existing docs unless the user explicitly approves.
- Treat the staged `.../<slug>.md` as a **generated, fidelity-critical artifact**:
  - **DO NOT EDIT** the generated Markdown by hand (including “small fixes” / formatting).
  - Put all project-specific notes, summaries, corrections, and decisions in a separate notes file next to it:
    - Preferred (one folder per doc): `README.md`
    - Flat layout fallback: `<slug>.README.md`
  - If the generated Markdown needs to change, **re-run MinerU and re-ingest** (overwrite intentionally) so it stays traceable to the source PDF.
- Keep docs timeless: do not add doc-level revision markers like “Draft/v1/初稿/修订记录”; rely on Git history instead.

## Directory conventions (default)

- Prefer an existing docs root: `docs/` (or `doc/` if that is what the repo uses).
- Default targets (create if missing):
  - `docs/datasheets/`
  - `docs/manuals/`
  - `docs/app-notes/`
  - `docs/errata/`
- Store as **generated artifacts** (immutable):
  - `.../<slug>.pdf` (original, for fidelity)
  - `.../<slug>.md` (generated, for reading/search — **DO NOT EDIT**)
  - `.../<slug>.assets/` (images and any extracted artifacts)
  - Optional: `.../<slug>.lock.json` (checksums + provenance; used to detect accidental edits)
- Store as **human notes** (editable):
  - Preferred (one folder per doc): `.../README.md` (project-specific summary, decisions, and remarks)
  - Flat layout fallback: `.../<slug>.README.md`

If your repo prefers “one folder per doc” (common), use:

- `docs/<category>/<slug>/`
  - `<slug>.pdf`, `<slug>.md`, `<slug>.assets/`, `<slug>.lock.json`, `README.md`

If the repo already has a different convention (e.g., `docs/hardware/datasheets/`), follow it.

## Workflow

### 1) Confirm inputs (minimal questions)

- Identify the **source**: local file path(s) and/or URL(s).
- Identify the **doc type**: datasheet / reference manual / app note / errata.
- Capture the **canonical identifiers** (when applicable): vendor, part number, doc title, revision/date.

### 2) Decide destination paths

- Pick the docs root (`docs/` preferred).
- Choose the category folder based on doc type.
- Choose a stable `<slug>`:
  - Prefer `vendor-part-doc` (e.g., `st-stm32h743-datasheet`)
  - Keep it filesystem-safe (lowercase, digits, hyphens)

### 3) Convert with mineru (Markdown-first)

- Convert using `mcp__mineru__parse_documents`:
  - Use `enable_ocr=false` by default.
  - Enable OCR only for scanned PDFs or when extraction quality is poor.
- Record `extract_path` from the tool output; it contains:
  - `full.md`
  - `*_origin.pdf`
  - optional `images/` folder and other metadata files

### 4) Move outputs into the project and localize images

- Use `scripts/ingest_mineru_extract.ts` to stage the mineru output into the target folder:
  - Copy `*_origin.pdf` -> `<slug>.pdf`
  - Copy `full.md` -> `<slug>.md`
  - Copy `images/` -> `<slug>.assets/images/`
  - Rewrite Markdown image links from `images/...` to `<slug>.assets/images/...`
  - Write `<slug>.lock.json` and set generated artifacts to read-only on disk to prevent accidental edits (defaults on).
  - Create a notes template alongside the generated artifacts (defaults on):
    - `README.md` when using `--doc-subdir`
    - `<slug>.README.md` when using a flat layout

Example (flat layout):

```bash
bun --no-install "$LOOMHELM_TOOLKIT_ROOT/skills/hardware-doc-ingest/scripts/ingest_mineru_extract.ts" \
  --extract-path "<mineru.extract_path>" \
  --dest-dir "docs/datasheets" \
  --slug "st-stm32h743-datasheet" \
  --add-header \
  --source-url "<source-url>" \
  --vendor "ST" \
  --part "STM32H743"
```

Example (one folder per doc, recommended):

```bash
bun --no-install "$LOOMHELM_TOOLKIT_ROOT/skills/hardware-doc-ingest/scripts/ingest_mineru_extract.ts" \
  --extract-path "<mineru.extract_path>" \
  --dest-dir "docs/datasheets" \
  --doc-subdir "st-stm32h743-datasheet" \
  --slug "st-stm32h743-datasheet"
```

Re-ingest / regenerate (explicit overwrite):

```bash
bun --no-install "$LOOMHELM_TOOLKIT_ROOT/skills/hardware-doc-ingest/scripts/ingest_mineru_extract.ts" \
  --extract-path "<mineru.extract_path>" \
  --dest-dir "docs/datasheets" \
  --doc-subdir "st-stm32h743-datasheet" \
  --slug "st-stm32h743-datasheet" \
  --overwrite
```

### 5) Update the docs index

- Prefer updating an existing docs index:
  - `docs/README.md`, `docs/index.md`, or the repo’s established docs TOC
- Add a short entry that links to Markdown first, PDF second:
  - `[Title](docs/.../<slug>.md) ([PDF](docs/.../<slug>.pdf)) — 1–2 line note`

If no docs index exists, create `docs/README.md` and add sections for Datasheets / Manuals / App Notes.

### 6) Future usage: prefer Markdown

When asked about the document contents later, read and cite from `.../<slug>.md` first; use the PDF as a fidelity fallback.

**Never** “edit the datasheet” by changing `.../<slug>.md`. Put your notes in `README.md` (or `<slug>.README.md` for flat layout).

Optional integrity check (useful in CI/pre-commit):

```bash
bun --no-install "$LOOMHELM_TOOLKIT_ROOT/skills/hardware-doc-ingest/scripts/verify_doc_locks.ts" docs/datasheets
```

## References (load only when needed)

- Docs index format and examples: `references/docs-index-format.md`
