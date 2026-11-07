---
name: storybook-screenshots
description: "Capture Storybook docs or canvas screenshots for local review or PR evidence."
---

# Storybook screenshots for local review or PR visual evidence

Use this skill when owner-facing local review evidence or PR visual evidence should come from Storybook component/fragment stories, Storybook docs pages, or a full page/app-shell Storybook fallback already authorized by `$ui-visual-evidence`.

## Responsibility boundary

- Supported source types:
  - `source_type=storybook_canvas`
  - `source_type=storybook_docs`
- Both are treated as mock evidence (`target_program=mock-only`), not real-program screenshots.
- This skill does not replace other image sources such as app pages, `ui_demo` pages, internal demo pages, or diagrams.
- For full page/flow evidence, this skill is valid only after `$ui-visual-evidence` has already selected Storybook as the fallback source under an existing explicit page-level exception.
- For PR URL rewriting/rendering safety, use the `pr_body_image_gate.ts` helper owned by `$ui-visual-evidence`.

## Default behavior

- If the change is component/fragment UI and Storybook is available, default to recommend `1-3` Storybook screenshots for local review; PR evidence can reuse the same stable asset set later with its own PR URLs.
- If full page/flow evidence is explicitly authorized to fall back to Storybook, capture the complete page/app-shell story that represents the acceptance target.
- Prefer `storybook_docs` when a docs page shows a useful state matrix or gallery in one view.
- Prefer `storybook_canvas` when you need to prove one exact state or one interaction step.
- For component/fragment/reusable-state evidence, capture the Story-owned presentation surface declared by `$storybook-stories`; do not add margin in the screenshot flow.
- If a screenshot depends on a specific mobile/tablet/desktop viewport, bind that viewport in the Storybook surface first; browser window size is an implementation detail, not the primary evidence control surface.
- The owner can reject screenshots. If rejected, record:
  - `PR截图=不存在`
  - `PR截图原因=主人拒绝`

## What is a valid Storybook screenshot

- Capture only the Storybook-rendered content area relevant to the evidence.
- Never include Storybook chrome: sidebar, toolbar, addons panel, story list, or browser URL bar.
- Never capture desktop fullscreen, the OS desktop, or unrelated windows.
- Prefer stable states that map directly to acceptance criteria.
- Prefer element-level capture of the rendered Storybook surface; use `capture_scope=browser-viewport` only when the whole rendered browser area is itself the evidence target.
- Page fallback captures may trim excess edge whitespace. Component captures keep their declared source surface unchanged unless the preflight can crop only excess inside that surface.

By source type:

- `storybook_canvas`
  - capture the component/fragment render viewport for one story, or an authorized full page/app-shell fallback story when no qualified `ui_demo` exists
  - best for exact default/error/loading/success states or interaction checkpoints
- `storybook_docs`
  - capture the docs content area or a specific gallery/grid section
  - best for multi-state overviews, component matrices, curated docs-first summaries, and page fallback state galleries

## Evidence mapping (must)

For each screenshot, include:

- `source_type=storybook_canvas|storybook_docs`
- `target_program=mock-only`
- `capture_scope=element|browser-viewport` (prefer `element`)
- `requested_viewport=<viewport key|WIDTHxHEIGHT|none>`
- `viewport_strategy=storybook-viewport|browser-resize-fallback`
- `margin_policy=trim_only|require_margin`
- `evidence_surface=component|page`
- `surface_selector` and `target_selector` for component evidence
- `sensitive_exclusion=N/A` (or a short explicit note)
- `submission_gate=pending-owner-approval|approved|rejected`
- `story_id_or_title` for canvas captures
- `docs_entry_or_title` for docs captures
- `state` or `scenario`
- `evidence_note` describing what implementation result the screenshot proves

Rules:

- `storybook_canvas` must include `story_id_or_title`
- `storybook_docs` must include `docs_entry_or_title`
- If a docs capture shows multiple states, use `scenario` to describe the gallery, for example `status matrix`
- If story/docs coverage is insufficient, update/add Storybook coverage first or explain why it is not possible
- If the requested proof still belongs to `ui_demo` or another locked non-Storybook source, return control to `$ui-visual-evidence` instead of reporting Storybook success here.
- Do not report `视觉证据目标源=ui_demo` from this skill; that value belongs to `$ui-visual-evidence` after the demo/browser evidence path runs.
- For component/fragment/reusable-state Storybook evidence, set `margin_policy=require_margin`, `evidence_surface=component`, and pass selectors for the source-managed surface and target.
- For full page/app-shell Storybook fallback, set `margin_policy=trim_only` and `evidence_surface=page`.

## Viewport-safe capture contract (must)

- When requested viewport matters, carry `requested_viewport` and `viewport_strategy` metadata with the capture notes.
- For mobile evidence, resolve the CSS viewport from owner, project, spec, and the selected story/docs surface before using the default `393x852` CSS px. When the default applies, bind the stable story/docs surface to it through the repo's Storybook viewport or scenario conventions, verify the rendered viewport, then record `requested_viewport=393x852`; if the surface cannot carry the viewport, return to `$storybook-stories` or report a blocker instead of applying capture-time emulation. Do not treat the size as physical pixels or device/User-Agent emulation.
- Default Storybook path:
  - choose or prepare a Storybook story/docs surface that already expresses the target viewport or responsive scenario;
  - use `viewport_strategy=storybook-viewport` whenever Storybook-native viewport controls or story-bound viewport settings are sufficient;
  - capture the rendered Storybook content as an element, not by resizing the browser window first.
- `capture_scope=browser-viewport` is allowed only when the whole rendered browser area is the evidence target and element capture would lose the proof.
- Do not use browser window resizing as the normal way to satisfy a Storybook viewport request.
- `browser-resize-fallback` is the exceptional last resort:
  - only after Storybook-native viewport handling cannot produce the requested proof;
  - record the reason the normal path failed;
  - restore the previous browser window size before handoff;
  - if restoration fails, do not treat the resized browser session as final owner-facing state.

## Capture selection guidance

Prefer `storybook_docs` when:

- one screenshot can prove several states at once
- the docs page already lays out the intended review surface cleanly
- the task is about comparing multiple variants or visual consistency

Prefer `storybook_canvas` when:

- the evidence is one exact state
- the screenshot should stay tightly cropped around one component or page state
- the proof depends on a single story's isolated rendering
- no qualified `ui_demo` exists, an existing explicit page-level exception authorizes the fallback, and a complete page/app-shell fallback story is the selected evidence surface

It is valid to mix both source types in one PR if that is the clearest evidence set.

## Source-managed component capture (must)

- A component capture performs exactly one DOM preflight before capture. It reads the declared `surface_selector` and `target_selector`, their rectangles, containment, overflow, and computed styles; it does not inject DOM, change styles, add padding, infer an image background, or persist a measurement receipt.
- The selected Story source must expose an outer `[data-visual-evidence-surface]` and a contained `[data-visual-evidence-target]`. The target includes the component's complete visible bounds; the surface owns all outer space.
- The surface must have an opaque, uniform, solid background from the active Story theme and no border, border radius, box shadow, gradient, image background, evidence-only color, card boundary, or nested-card appearance. Its background must be a natural extension of the Story, not a capture frame.
- Compute `required_margin=clamp(round(long_edge * 0.02), 16, 48)` from the target rectangle. Measure left, top, right, and bottom target-to-surface margins once. Every side must be at least `required_margin`; no side may exceed `48px` in the final capture.
- When one or more sides exceed `48px`, tighten only the capture rectangle within the declared surface, using the known DOM geometry to retain `48px` on those sides. This is a lossless crop of the source-managed surface, never an image-analysis crop.
- Block and return control to `$storybook-stories` when a selector is missing, the surface is transparent or visually framed, the target escapes the surface, a margin is below `required_margin`, or a natural theme surface cannot be established. Report the measured selectors, rectangles, computed style failure, and per-side margins as the reason.
- For a valid component surface, capture it unchanged when no side exceeds `48px`; do not call `trim_whitespace.ts --margin-policy=require_margin`. That compatibility mode intentionally blocks component image processing.
- For page/app-shell fallback only, pass the raw image through `trim_whitespace.ts --margin-policy=trim_only`: it detects a mostly-uniform border background, trims edge-connected excess whitespace, preserves `clamp(round(long_edge * 0.02), 16, 48)` px where available, and otherwise retains the original image.
- Do not use any normalization to cut into docs content areas, internal white gaps, or component/page padding.

## Asset placement

- If the screenshot is spec-related, newly added/replaced images MUST be stored in:
  - `docs/specs/<topic>/assets/`
- If the screenshot is legacy plan-related, newly added/replaced images MUST be stored in:
  - the associated plan directory's `assets/` so `PLAN.md` can reference them via `./assets/<file>`
- For spec/plan-related evidence, update the corresponding source-of-truth file section:
  - preferred `SPEC.md` `## Visual Evidence` for `Spec:` / `Specs:`
  - preferred `PLAN.md` `## Visual Evidence` for legacy `Plan:` / `Plans:`
- If a historical spec/plan still has retired PR selectors or `## Visual Evidence (PR)`, run `bun --no-install skills/bin/visual_evidence_document.ts migrate --path <touched-spec-or-plan>` before handoff. Ambiguous sections containing images remain unchanged and require a manual decision.
- Use `![alt](./assets/<file>)` entries as the visual-evidence source of truth inside the relevant section.
- PR transport selection is task-scoped and must be passed explicitly to `pr_body_image_gate.ts` Phase A with repeated `--evidence` paths or `--no-evidence`; the owner-facing section is not a PR selector database.
- If an image already exists in another repo path, do not relocate it only for PR formatting.

## Local chat return path (must)

- Storybook asset placement and chat image paths are different concerns.
- Keep the canonical review asset in its repo/spec/plan path as usual.
- Before showing any local Storybook image in chat, create an immutable snapshot with:
  - `bun --no-install "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/bin/snapshot_local_image.ts" --source <image-path> --cwd <working-dir>`
- Use only the returned `snapshot_path` in chat Markdown.
- Never point chat Markdown directly at `docs/specs/.../assets/...`, temporary Storybook capture files, or other mutable working paths.

## Commit and push strategy (must)

- For local-review-only captures, do not require a dedicated screenshot commit or any push.
- If PR later reuses image files that were already committed during local review, do not require a new screenshot-only commit or history rewrite; pass the selected paths to the task-scoped PR gate as needed.
- Use a dedicated screenshot-only commit only when this phase adds or replaces image files specifically for PR evidence after PR flow has already started.
- Commit message convention for PR-bound screenshot commits:
  - `chore(pr-screenshots): add visual evidence`
  - `chore(pr-screenshots): refresh visual evidence`
- Push dedicated screenshot commits separately from implementation commits, and treat that push as a dedicated visual-evidence phase.
- Before pushing PR-bound screenshot changes, show the same image asset set in chat and ask the owner for explicit submit approval.
- If owner approval is missing, do not push screenshot commits.

When the owner asks to update/replace screenshots:

- prefer replacing the existing screenshot commit only when this PR already has a dedicated screenshot phase commit
- if the PR is reusing screenshots from earlier implementation commits, update the task evidence declaration without rewriting history
- before force-pushing a true screenshot refresh, confirm rewrite safety
- if rewrite safety cannot be confirmed, fall back to a new dedicated screenshot commit

## PR body snippet (with metadata)

```md
## Visual Evidence

- source_type: storybook_docs
  docs_entry_or_title: Components/Button/Docs
  scenario: state matrix
  evidence_note: verifies primary, secondary, disabled, and loading button states in one review surface
  image:
  ![Button state matrix](https://<host>/<owner>/<repo>/blob/<pr_head_branch>/docs/specs/<topic>/assets/button-state-matrix.png?raw=1)

- source_type: storybook_canvas
  story_id_or_title: Components/Button/Loading
  state: loading
  evidence_note: verifies exact loading spinner placement
  image:
  ![Button loading](https://<host>/<owner>/<repo>/blob/<pr_head_branch>/docs/specs/<topic>/assets/button-loading.png?raw=1)
```

Do not maintain this block manually when the PR is spec-associated:

- use `pr_body_image_gate.ts` Phase A once during PR creation (`PR.head.ref`)
- do not rerun Phase A for ordinary pushes to the same PR branch
- use `pr_body_image_gate.ts` Phase B once after merge (`merge_commit_sha`)

## Final reply contract

- Always report:
  - `视觉证据=存在/不存在/未检查`
  - `视觉证据目标源=storybook_docs|storybook_canvas|未确定`
  - `空白裁剪=已裁剪/无需裁剪/不适用/未检查`
- Always report local review status:
  - `聊天回图=已展示/未展示/未检查`
- Always report:
  - `PR截图=存在/不存在/未检查`
- Always report screenshot commit status:
  - `截图提交=存在/不存在/不适用/未检查`
- Always report policy status:
  - `截图策略合规=存在/不存在/未检查`
  - `目标程序声明=存在/不存在/未检查`
  - `提交授权=存在/不存在/不适用/未检查`
- If `视觉证据=存在`, the final reply must include the same screenshot asset set that was actually returned for local review in chat, even when `PR截图=不存在`.
- For local screenshots, those chat markdown images must use the immutable snapshot paths returned from `snapshot_local_image.ts`.
- If `PR截图=存在`, include the same screenshot asset set in the final reply, but keep transport URLs separate: Chat uses snapshot paths and the PR body uses GitHub-normalized Markdown links.
- For component/fragment/reusable-state evidence, report `视觉证据=不存在` and `空白裁剪=不适用` when preflight blocks; include the measured reason and return to `$storybook-stories`. Report `空白裁剪=无需裁剪` when the declared surface is captured unchanged, and `空白裁剪=已裁剪` only when the DOM geometry tightened excess space inside that surface.
- If screenshot generation was applicable but skipped, explain why in one line.
