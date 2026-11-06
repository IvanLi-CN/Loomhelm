# Docs index format (hardware PDFs)

Keep index files small and skimmable. Prefer linking to Markdown first, PDF second.

## Recommended section structure

If the repo does not already have a docs TOC, create `docs/README.md` with:

```md
# Docs

## Datasheets

- [ST STM32H743 Datasheet](datasheets/st-stm32h743-datasheet.md) ([PDF](datasheets/st-stm32h743-datasheet.pdf)) — MCU datasheet; use for pinout, electrical specs.

## Manuals

- [ST RM0433 Reference manual](manuals/st-rm0433-reference-manual.md) ([PDF](manuals/st-rm0433-reference-manual.pdf)) — Peripheral registers and programming model.

## App notes

- [ANxxxx: Foo](app-notes/st-anxxxx-foo.md) ([PDF](app-notes/st-anxxxx-foo.pdf)) — Implementation guidance; note any key constraints.

## Errata

- [ESxxxx: Bar](errata/st-esxxxx-bar.md) ([PDF](errata/st-esxxxx-bar.pdf)) — Known silicon issues; track applied workarounds.
```

## Entry checklist

- Include vendor + part number (or board name) in the link title.
- Link Markdown first; include a PDF link for fidelity.
- Add a 1–2 line note that describes what the doc is _for_.
- Avoid doc-level revision markers like “Draft/v1/终稿/修订记录”.
