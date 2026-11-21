# Evidence lifecycle

Comparison, owner confirmation, immutable chat return, asset persistence, and PR body images.

## Compare against the bound baseline

Capture and normalize final candidate images into a temporary, non-canonical location before replacing an associated Spec/Plan asset. Compare each candidate only against the Git blob at its exact repo-relative destination path in the locked `FlowLedger.base_sha`:

```sh
bun --no-install skills/ui-visual-evidence/scripts/compare_visual_evidence.ts \
  --base-sha <FlowLedger.base_sha> \
  --candidate <repo-relative-destination-path> <normalized-final-image> \
  --output-dir <temporary-comparison-directory>
```

The helper reads only the Git blob at that exact path. It reports same-path pairs, size and RGBA pixel facts including transparency, unreadable inputs, and a heatmap per readable pair. Missing base paths are `current-only` with no baseline or heatmap. Any `current-only` or unreadable pair sets `confirmation_required`; there is no ordering, count, or similar-image fallback. It does not judge whether a difference is meaningful and uses no numeric threshold.

Inspect the previous image, candidate image, and heatmap before deciding whether the rendered UI changed. Any visible text, layout, color, control, data, state, or viewport change is meaningful. PNG encoding changes and outer-margin or crop normalization are not meaningful only when that inspection establishes the inner UI is unchanged.

## Owner confirmation

- All comparable, no meaningful UI change: report `视觉比较=一致` with `与上一版视觉一致`, reuse the existing canonical assets instead of creating new ones, and snapshot and show that set without asking the owner to reply.
- Missing baseline, differing image count or order, an unreadable input, or a meaningful change: report `视觉比较=需确认`, show all applicable baseline images, current images, and every available heatmap, and link the interactive report as an additional inspection view. When the report cannot be created, state why and still show the same applicable set; with no readable baseline, show only current images.
- Ask one plain question such as `这些截图准确反映了本次改动吗？` and accept any clear natural-language confirmation of the displayed screenshots. `确认截图` is an example, never a required reply format; a bare `继续` does not answer it. Persist the current images as canonical assets only after that confirmation.
- This acceptance only establishes that the displayed screenshots are accurate. It never grants a delivery action; PR publication, reuse, CI, review, and merge keep their caller's authorization.
- No feasible local render/test source: report `视觉证据=不存在` with the concrete blocker. Only the workflow PR publication procedure with `mode=draft-bootstrap` may create a feedback-only Draft, under existing or explicit delivery authorization. That Draft is not local verification and cannot bind a receipt, start convergence, formal review, required-CI tracking, or merge; remote feedback images go through this same comparison before normal continuation.

## Interactive inspection report

When a meaningful change needs confirmation and readable baselines exist, make one `reg-cli` report for all comparable pairs. Snapshot the exact Git baseline blobs and final candidate images with `snapshot_local_image.ts` first, then pass those snapshot paths to `skills/bin/create_reg_cli_report.ts` with a repeated `--pair NAME EXPECTED_SNAPSHOT ACTUAL_SNAPSHOT` and `--cwd` for the current repository.

The helper links the snapshots without copying them, generates diff assets, and stores `report.html`, `reg.json`, and a dependency manifest with input hashes under the repo/date hierarchy in `$CODEX_HOME/user-inline-assets/`. The asset volume must support APFS copy-on-write cloning; the helper fails closed otherwise. Outputs are cloned for publication while source images stay symlinks.

Link `report.html` in chat as a normal file link, not an iframe. Its symlinks stay valid only while the referenced snapshots remain. Before deleting old snapshots, run `skills/bin/create_reg_cli_report.ts audit <report-directory>` for reports you intend to keep and retain their dependencies, or clean the reports together with them. `current-only` images cannot enter a two-sided comparison and must still be shown directly. Keep the same-path RGBA/heatmap comparison as the source of visual facts; the report is for inspection, not for changing the confirmation decision.

## Immutable chat return

Before any owner-facing local image is shown in chat, create an immutable snapshot:

```sh
bun --no-install "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/bin/snapshot_local_image.ts" --source <image-path> --cwd <working-dir>
```

Use only the returned `snapshot_path` in chat Markdown. Always show the same final image asset set in chat before declaring visual verification complete.

Canonical repo paths and chat-return paths are separate concerns: repo/spec/plan files keep their stable project paths, chat Markdown points at the immutable snapshot under `$CODEX_HOME/user-inline-assets/`. A remote image URL is allowed in chat only as an ordinary hyperlink, never as a rendered image source.

## Asset placement

- Spec-associated tasks store new evidence in `docs/specs/<topic>/assets/` and write the selected images into the preferred `## Visual Evidence` section. Historical ID-prefixed Spec asset paths stay readable but are not created anew.
- Legacy plan-associated tasks store evidence in the plan directory's `assets/` and write into that `PLAN.md` preferred `## Visual Evidence` section.
- Entries use `![alt](./assets/<file>)`.
- If a historical spec/plan still has retired PR selectors or `## Visual Evidence (PR)`, run `bun --no-install skills/bin/visual_evidence_document.ts migrate --path <touched-spec-or-plan>` before handoff. Ambiguous sections containing images stay unchanged and need a manual decision.
- PR transport selection is task-scoped: pass the selected repo-relative paths to `pr_body_image_gate.ts` Phase A with repeated `--evidence`, or pass `--no-evidence`. Do not add selector markup to the Spec/Plan; the touched-file migration handles retired lines and legacy headings before PR convergence.

## PR body image gate

The workflow PR procedures call this Skill's `pr_body_image_gate.ts` for both phases. The helper is the only writer and renderer verifier for the managed `## Visual Evidence` section:

- Phase A accepts exactly one explicit Task Evidence Set (`--evidence` repeated) or `--no-evidence`, rewrites the section against the open PR head branch, and verifies the selected platform's rendered Markdown HTML.
- Phase B accepts no new image selection, reads only the managed section, rewrites URLs to the base repository and actual merge commit SHA, verifies rendered Markdown HTML, and reports bounded retryable failures without changing merge state.
- Focused offline coverage: `bun --no-install test skills/ui-visual-evidence/scripts/test_pr_body_image_gate.ts` and `bun --no-install skills/bin/pr_body_image_contract_check.ts`.

PR body writes use provider-specific concurrency guards. Gitea sends its `content_version`. GitHub's pull-request PATCH endpoint rejects conditional request headers, so GitHub refreshes identity and body before the PATCH and verifies them again afterward. This detects changes observed around the write but is not an atomic compare-and-swap or a provider-guaranteed concurrency guarantee.
