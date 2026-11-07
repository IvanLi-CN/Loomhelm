---
name: ui-visual-evidence
description: "Clear the visual-evidence gate for UI and non-UI work."
---

# ui-visual-evidence

Use this skill whenever the visual-evidence gate must be cleared before work is treated as visually verified, locally ready to open a PR (`可开 PR（local）`), or local-merge-ready. That includes both `UI-affecting` work that needs stable rendered images and clearly non-UI work that must explicitly report `视觉证据=不适用`.

## Goal

- Determine whether the work is truly `UI-affecting`.
- Provide the canonical `视觉证据=不适用` path for clearly non-UI work.
- Pick the most stable render source for the current UI surface.
- Prefer mock-first, deterministic evidence instead of ad-hoc real-program screenshots.
- Prefer source-managed or emulated viewport control over mutating the browser window.
- Keep page evidence compact with trim-only normalization, and require source-managed presentation surfaces for component evidence.
- For `web_component` / reusable-state / `mock_ui` evidence, treat source-owned outer margin as a hard gate rather than a screenshot-time cosmetic operation.
- Return the same final image asset set in chat and, when applicable, persist it into the associated spec; Chat and PR transport URLs remain separate.
- Compare each normalized candidate against the associated Spec/Plan evidence before interrupting the owner.
- Snapshot every owner-facing local chat image into `$CODEX_HOME/user-inline-assets/` before replying so historical chat renders stay immutable.

## Applicability gate

Treat the current work as `UI-affecting=yes` when ANY is true:

- the requirement or spec explicitly asks for a UI, page, screen, component, visual polish, or interaction surface;
- changed files live under UI/story/render/display paths;
- acceptance criteria are inherently visual or interaction-facing;
- the task changes Storybook stories/docs, a browser-rendered surface, an app window, or an embedded display render.

If the work is clearly non-visual, record:

- `视觉证据=不适用`
- `视觉证据原因=<one concrete reason>`

If you cannot safely decide, stop and ask one concise question instead of guessing.

## Source selection order

Use the first applicable source from this list:

1. `ui_demo`
2. `storybook_docs`
3. `storybook_canvas`
4. `mock_ui`
5. `firmware_preview`
6. `target_app_window`

Rules:

- Web UI components/fragments/reusable states + Storybook detected:
  - clear `$storybook-stories` first for the changed component/fragment surface
  - if the already-cleared `$storybook-stories` result resolved `视觉证据目标源=storybook_canvas`, or the repo/changed surface is using a stable canvas-only Storybook convention, keep `storybook_canvas` as the selected source
  - otherwise default to `storybook_docs`
  - use `storybook_canvas` when one exact state or one interaction checkpoint is clearer, or when docs-first would contradict the repo's current stable Storybook convention
- Web UI pages/flows/app shells:
  - default to `ui_demo` when a stable pure-frontend demo surface exists
  - `ui_demo` must be mock-only, require no login, avoid real backend dependencies, and be reproducible from repo scripts or static assets
  - if no qualified `ui_demo` exists and Storybook is detected, first confirm an existing explicit page-level exception in owner instructions, project documentation, or the active spec; only then clear `$storybook-stories` for a complete page/app-shell fallback before capture
  - if no such exception is recorded, report the page evidence blocker; absence of a qualified `ui_demo` alone does not authorize Storybook fallback
  - do not require a full page Storybook entry when a qualified `ui_demo` already provides the page/flow evidence
- Mixed Web UI work:
  - use Storybook for changed components/fragments/reusable states
  - use `ui_demo` for changed full page/flow evidence
- Web/App UI without Storybook:
  - prefer a deterministic mock preview or test/demo surface
  - use `$ego-browser` for browser validation and capture
- Firmware / embedded display UI:
  - prefer `$firmware-display-preview`
- `target_app_window` is the exception path:
  - only when mock/story/simulator evidence is unavailable
  - require explicit owner confirmation for `target_program` and `capture_scope`

## Owner source lock

Treat any explicit final-source instruction such as `web demo`, `ui_demo`, or `not Storybook` as a locked source unless the owner later changes it.

Rules:

- A locked non-Storybook source outranks the normal source-selection order for the same evidence target.
- If the owner explicitly locks a non-Storybook source for a full page/flow, do not substitute `storybook_docs` or `storybook_canvas` and then report success as if the original request were satisfied.
- If the locked source is currently unavailable or non-deterministic, stop and report `视觉证据=不存在` plus a concrete `视觉证据原因`, or first repair that source and then capture from it.
- Storybook remains valid for components/fragments/reusable states, and for full page/app-shell fallback only when no owner lock conflicts, no qualified `ui_demo` exists, and an existing explicit page-level exception authorizes the fallback.

## Workflow

### 1) Confirm the evidence target

- Identify the UI surface:
  - `web_component`
  - `web_page`
  - `app_window`
  - `firmware_display`
  - `other_visual_surface`
- Capture evidence from the current local implementation.
- Resolve two internal metadata fields before capture:
  - `margin_policy=require_margin` for `web_component`、组件片段、可复用状态和 `mock_ui`; this selects the source-managed DOM preflight, not image normalization
  - `margin_policy=trim_only` for `ui_demo`、整页/流程 Storybook fallback 与其他页面级 surface
  - `evidence_surface=component|page|mock_ui|app_window|firmware_display|other_visual_surface` to describe which branch the shared helper is allowed to use
- For `web_page`, decide whether the evidence source is `ui_demo`, an explicitly authorized Storybook page fallback, or a non-web fallback before starting a browser session.
- For `web_page` / `app-shell` / `page-flow`, resolve any locked source before treating Storybook fallback as valid.
- For mobile UI evidence, resolve the requested CSS viewport in this order: owner-explicit size, project/spec/source-defined size, then the default `393x852` CSS px. A Storybook story or demo scenario that already binds a viewport counts as project/source-defined and must not be replaced by the default.
- Treat `393x852` as a deterministic responsive-review viewport, not as a physical-pixel resolution or a requirement to emulate a particular user agent. Record it as `requested_viewport=393x852` whenever the default is used.

### 2) Establish deterministic input

- Prefer mock data, fixtures, or simulator inputs.
- Reuse repo-native mock/provider patterns; do not invent an isolated fake stack if the repo already has one.
- For `ui_demo`, verify the surface is mock-only, login-free, independent of real backend services, and reproducible from repo scripts or static assets.
- If the selected source cannot be rendered deterministically yet, fix the source first instead of capturing unstable evidence.
- If the owner-locked source cannot yet be rendered deterministically, do not silently switch to another source. Repair it or report the blocker.

### 3) Clear prerequisite coverage

- If the target is a Web UI component/fragment/reusable state and Storybook is detected:
  - run `$storybook-stories`
  - require `Storybook覆盖=通过` before Storybook capture
- If the target is a full Web page/flow and a qualified `ui_demo` exists:
  - report `Storybook覆盖=不适用` for page-level coverage unless changed reusable components also require Storybook
  - do not create or require full page Storybook stories
- If the target is a full Web page/flow, no qualified `ui_demo` exists, Storybook is detected, and an existing explicit page-level exception authorizes the fallback:
  - run `$storybook-stories` for a complete page/app-shell fallback
  - require `Storybook覆盖=通过` before Storybook fallback capture
- If the target is a full Web page/flow and no qualified `ui_demo` exists but no existing explicit page-level exception is recorded:
  - report the page evidence blocker; the absence of `ui_demo` alone does not authorize Storybook fallback
- If the target is a full Web page/flow and the owner explicitly locked a non-Storybook source:
  - keep `视觉证据目标源` fixed to that source
  - if it is unavailable, report the blocker instead of downgrading success to Storybook fallback
- If coverage is blocked, stop and report the blocker instead of falling back silently.

### 4) Capture evidence with the source skill

- Before the first `$ego-browser` command, read and follow its task-space workflow.
- `storybook_docs` / `storybook_canvas` => use `$storybook-screenshots`
- `ui_demo` => use `$ego-browser` for ordinary browser validation; use the explicit `chrome-devtools` exception path only when viewport emulation or element-first capture is required, and keep capture scope limited to the relevant demo-rendered surface
- `mock_ui` => use `$ego-browser` for ordinary browser validation; use the explicit `chrome-devtools` exception path only when viewport emulation or element-first capture is required, and keep capture scope limited to the relevant rendered surface
- `firmware_preview` => use `$firmware-display-preview`
- `target_app_window` => only after explicit owner approval

### 4.1) Viewport-safe browser evidence ladder

- When viewport matters, keep `requested_viewport` and `viewport_strategy` metadata with the chosen evidence source.
- When mobile evidence is required and no owner, project, spec, or selected source surface specifies a viewport, use `requested_viewport=393x852` CSS px as the default mobile acceptance size.
- Before recording the fallback, bind the selected surface to `393x852` CSS px and prove the rendered viewport. Storybook must use a stable viewport-bound story/docs surface and return to `$storybook-stories` when one is missing; demo or mock sources without source-managed controls may use their source-appropriate viewport emulation path.
- Default ladder:
  - `ui_demo` => source-managed demo scenario (`viewport_strategy=ui-demo-source`) when available, otherwise `viewport_strategy=devtools-emulate` + element-first capture
  - `storybook_docs` / `storybook_canvas` => source-managed viewport (`viewport_strategy=storybook-viewport`) + element-first capture
  - `mock_ui` => `viewport_strategy=devtools-emulate` + element-first capture
  - `capture_scope=browser-viewport` only when the whole rendered browser area is itself the evidence target
  - `browser-resize-fallback` only after the normal path cannot satisfy the requested proof
- Never choose browser window resize as the initial plan for Storybook, `ui_demo`, or `mock_ui` evidence.
- `devtools-emulate` in this section is a current-truth `chrome-devtools` exception path for evidence capture, not the default general browser route.
- If `browser-resize-fallback` is used, record the reason and restore the original browser window size before handoff; if restoration fails, treat the evidence flow as blocked instead of handing off the mutated browser state.

Never:

- capture the desktop fullscreen
- capture unrelated windows
- use “fullscreen first, crop later” as a workaround

### 4.5) Preserve source-managed component space and trim page whitespace

- A component, fragment, reusable state, or `mock_ui` source selected as evidence must declare `[data-visual-evidence-surface]` around `[data-visual-evidence-target]`. The target covers all visible component effects; the surface owns its real outer margin and uses an opaque, uniform, solid active-theme background.
- The surface must not add border, radius, shadow, gradient, image background, evidence-only color, a card boundary, or nested-card presentation. Do not add spacing when the component and its natural Story canvas already provide a compliant margin.
- Before capture, run one DOM preflight only: read the declared selectors, target/surface rectangles, containment, overflow, and computed styles. Compute `required_margin=clamp(round(long_edge * 0.02), 16, 48)` from the target and measure all four target-to-surface margins. Each must be within `[required_margin, 48]` after any allowed tightening.
- If a side exceeds `48px`, crop the capture rectangle only inside the declared surface from known DOM geometry, retaining `48px` on that side. Do not analyze pixels, inject a wrapper, mutate the DOM, change CSS, add synthetic padding, infer a background, or save a measurement receipt.
- Block component evidence when either selector is absent, the surface is transparent or framed, the target escapes the surface, a side is below `required_margin`, or the background is not a natural opaque theme surface. Return the source work to `$storybook-stories` when Storybook owns it.
- For `ui_demo` and full page/app-shell Storybook fallback only, pass the raw image to `skills/ui-visual-evidence/scripts/trim_whitespace.ts --margin-policy=trim_only`. It may trim edge-connected excess whitespace while preserving `clamp(round(long_edge * 0.02), 16, 48)` px; ambiguous borders and already-tight pages retain the original image.
- `trim_whitespace.ts --margin-policy=require_margin` remains a compatibility input but always returns `blocked` with `source_managed_surface_required` before pixel analysis. `firmware_preview` and `target_app_window` remain outside automatic whitespace handling.

### 5) Persist and return

- Always show the same final image asset set in chat before declaring visual verification complete.
- Before any owner-facing local image is shown in chat, create an immutable snapshot with:
  - `bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/bin/snapshot_local_image.ts" --source <image-path> --cwd <working-dir>`
  - use only the returned `snapshot_path` in chat Markdown
- If the task is spec-associated:
  - store new visual evidence assets in `docs/specs/<topic>/assets/`; keep historical ID-prefixed Spec asset paths readable, but do not create new ones
  - write the selected owner-facing images into the preferred `## Visual Evidence` section
- If the task is legacy plan-associated:
  - store visual evidence assets in the associated plan directory's `assets/`
  - write the selected owner-facing images into that `PLAN.md` file's preferred `## Visual Evidence` section
- Canonical repo/spec/plan asset paths and chat-return paths are different concerns:
  - repo/spec/plan files keep their normal stable project paths
  - chat Markdown must point at the immutable snapshot copy instead of those mutable working paths
- Chat and PR can reuse the same logical image asset set, but not the same Markdown URLs:
  - Chat Markdown uses the readable immutable `snapshot_path` under `$CODEX_HOME/user-inline-assets/`
  - PR Markdown uses the selected code-hosting-platform URL produced by the local `pr_body_image_gate.ts` Phase A helper
  - a remote image URL is allowed only as an ordinary hyperlink, never as a rendered Chat Markdown/HTML image source
- If the same assets later become PR evidence, pass the selected repo-relative paths explicitly to `pr_body_image_gate.ts` Phase A with repeated `--evidence`, or pass `--no-evidence`. Do not add selector markup to the Spec/Plan; a touched-file migration/check handles retired lines and legacy headings before PR convergence.
- Capture and normalize final candidate images into a temporary, non-canonical location before replacing an associated Spec/Plan asset. Compare each candidate only against the Git blob at its exact repo-relative destination path in the locked `FlowLedger.base_sha`:

  ```sh
  bun skills/ui-visual-evidence/scripts/compare_visual_evidence.ts \
    --base-sha <FlowLedger.base_sha> \
    --candidate <repo-relative-destination-path> <normalized-final-image> \
    --output-dir <temporary-comparison-directory>
  ```

  The comparison helper reads only the Git blob at the exact destination path from `FlowLedger.base_sha`. It reports same-path pairs, size and RGBA pixel facts (including transparency), unreadable inputs, and a heatmap for each readable pair. Missing base paths are `current-only` and do not produce a baseline or heatmap. Any `current-only` or unreadable pair sets `confirmation_required`; there is no ordering, count, or similar-image fallback. It does not decide whether a difference is meaningful and does not use a numeric threshold.
- Inspect the previous image, candidate image, and heatmap before deciding whether the rendered UI changed. Any visible text, layout, color, control, data, state, or viewport change is meaningful. PNG encoding changes and outer-margin/crop normalization are not meaningful only when that inspection establishes that the inner UI is unchanged.
- When a meaningful visual change needs owner confirmation and readable baselines exist, make one interactive `reg-cli` report for all comparable pairs. Snapshot the exact Git baseline blobs and final candidate images with `snapshot_local_image.ts` first, then pass their existing snapshot paths to `skills/bin/create_reg_cli_report.ts` with a repeated `--pair NAME EXPECTED_SNAPSHOT ACTUAL_SNAPSHOT` and `--cwd` for the current repository. The helper links those snapshots without copying input images, generates diff assets, and stores `report.html`, `reg.json`, and a dependency manifest with input hashes beneath the existing repo/date hierarchy in `$CODEX_HOME/user-inline-assets/`. The asset volume must support APFS copy-on-write file cloning; report and diff outputs are cloned for publication, while source images remain symlinks. The helper fails closed otherwise. Keep the same-path RGBA/heatmap comparison above as the source of visual facts; the report is for inspection, not for changing the confirmation decision.
- Link `report.html` in chat as a normal file link, not an iframe. Its symlinks remain valid only while the referenced snapshots remain. Before cleaning old snapshots, run `skills/bin/create_reg_cli_report.ts audit <report-directory>` for reports you intend to keep; retain their dependencies or clean the reports together with them. `current-only` images cannot be placed in a two-sided comparison and must still be shown directly.
- When all images are comparable and the Agent finds no meaningful UI change:
  - report `视觉比较=一致` and briefly state `与上一版视觉一致`;
  - reuse the existing canonical Spec/Plan assets instead of creating new ones;
  - snapshot and show that canonical final asset set in chat without asking the owner to reply.
- When the baseline is missing, the image count/order differs, an input cannot be compared, or the Agent finds a meaningful UI change:
  - report `视觉比较=需确认`;
  - show all applicable baseline images, current images, and every available heatmap in chat, and link the interactive report covering every readable pair as an additional inspection view; when the report cannot be created, state why and still show the same applicable image set; when there is no readable baseline, show only the current images;
  - ask one plain question such as `这些截图准确反映了本次改动吗？`;
  - accept any clear natural-language confirmation of the displayed screenshots. `确认截图` is an example, never a required reply format. A bare `继续` does not answer the question.
  - only after that confirmation persist the current images as canonical assets and update the preferred section.
- This visual acceptance only establishes that the displayed screenshots are accurate. It never grants a delivery action; PR publication, reuse, CI, review, and merge continue to use their caller's authorization.
- When no local render/test source is feasible, report `视觉证据=不存在` with the concrete blocker. The workflow PR publication procedure with `mode=draft-bootstrap` may create a feedback-only Draft only under existing or explicit delivery authorization. It is not local verification and cannot bind a receipt, start convergence, formal review, required-CI tracking, or merge. Once remote feedback images exist, compare them by this same rule before the Draft may continue normally.

### 6) Staleness rules

Evidence becomes stale immediately when:

- a new local commit changes the rendered surface or its render inputs
- base sync changes the local implementation in a way that changes the rendered surface or its render inputs
- mandatory review repair or local-merge proof produces a new implementation that changes the rendered surface or its render inputs
- the chosen render source no longer reflects the latest implementation
- exception: a metadata-only evidence-persistence commit that only stores reviewed images, asset references, or legacy-block migration does not require a new owner response when a current capture and comparison still establishes that the inner UI is unchanged

When stale, recapture and compare again. A previous confirmation applies only to the images that were displayed with that question.

## PR body image gate

The workflow PR procedures call this skill's `pr_body_image_gate.ts` for the two PR-body phases. The helper is the only writer and renderer verifier for the managed `## Visual Evidence` section:

- Phase A accepts exactly one explicit Task Evidence Set (`--evidence` repeated) or `--no-evidence`, rewrites the section against the open PR head branch, and verifies the selected platform's rendered Markdown HTML.
- Phase B accepts no new image selection, reads only the managed section, rewrites URLs to the base repository and actual merge commit SHA, verifies rendered Markdown HTML, and reports bounded retryable failures without changing merge state.
- Run the focused offline coverage with `bun test skills/ui-visual-evidence/scripts/test_pr_body_image_gate.ts` and `bun skills/bin/pr_body_image_contract_check.ts`.

PR body writes use provider-specific concurrency guards. Gitea sends its `content_version`. GitHub's pull-request PATCH endpoint rejects conditional request headers, so GitHub performs an identity/body refresh before the PATCH and verifies identity/body again afterward. This detects changes observed around the write but is not an atomic compare-and-swap or a provider-guaranteed concurrency guarantee.

## Final report contract

Always report:

- `Storybook覆盖=通过/阻断/不适用/未检查`
- `视觉证据目标源=ui_demo|storybook_docs|storybook_canvas|mock_ui|firmware_preview|target_app_window|未确定`
- `视觉证据=存在/不存在/不适用/未检查`
- `空白裁剪=已裁剪/无需裁剪/不适用/未检查`
- `聊天回图=已展示/未展示/不适用/未检查`
- `证据落盘=已落盘/未落盘/不适用/未检查`
- `视觉比较=一致/需确认/不适用/未检查`
- `视觉证据原因=<one line when skipped/blocked>`

Status semantics:

- Use `视觉证据=不存在` when a required or owner-locked source is unavailable, unstable, or blocked.
- When `margin_policy=require_margin`, use `视觉证据=不存在` and `空白裁剪=不适用` when source-managed preflight fails. State the selectors, measured margins, and the concrete failure; no helper fallback is allowed.
- Do not claim a locked `ui_demo` / `web demo` request was satisfied by Storybook. In that situation, `视觉证据=不存在` plus a blocker reason is the correct outcome until the locked source is repaired or the owner changes the requirement.
- Keep the owner-facing field name `空白裁剪` unchanged. For valid component evidence use `无需裁剪` when capturing the declared surface unchanged and `已裁剪` only for DOM-geometry tightening within that surface; use `不适用` on a component preflight blocker. Page trim-only behavior keeps its existing `已裁剪/无需裁剪` meanings.
- Do not request confirmation for `视觉比较=一致`. For `视觉比较=需确认`, show the complete applicable image set before accepting a clear owner reply; do not make the owner inspect source control identifiers or image digests.

If evidence exists, include the same final image asset set shown to the owner. For Chat local images, the Markdown entries must use the snapshot paths returned from `snapshot_local_image.ts`, not raw repo asset paths, working preview files, or PR code-hosting URLs.
