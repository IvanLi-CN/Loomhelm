# Storybook capture

Stage used when `视觉证据目标源` is `storybook_docs` or `storybook_canvas`. Both are mock evidence (`target_program=mock-only`), never real-program screenshots.

## Source choice

- Prefer `storybook_docs` when one screenshot can prove several states at once, the docs page already lays out the review surface cleanly, or the task compares variants for visual consistency.
- Prefer `storybook_canvas` when the evidence is one exact state, the proof depends on a single story's isolated rendering, or an authorized complete page/app-shell fallback story is the selected surface.
- Mixing both source types in one evidence set is valid when that is the clearest proof.
- Prefer `1-3` screenshots for a component/fragment change. PR evidence reuses the same stable asset set with its own transport URLs.

## Valid screenshot

- Capture only the Storybook-rendered content area relevant to the evidence.
- Never include Storybook chrome: sidebar, toolbar, addons panel, story list, or browser URL bar.
- Never capture desktop fullscreen, the OS desktop, or unrelated windows.
- Prefer element-level capture of the rendered surface; use `capture_scope=browser-viewport` only when the whole rendered browser area is itself the evidence target.
- Capture the Story-owned presentation surface for component evidence; do not add margin during capture. Geometry rules live in `component-surface-preflight.md`.
- Bind viewport-dependent scenarios in the Storybook surface first per `viewport-ladder.md`; browser window size is not the control surface.

By source type:

- `storybook_canvas`: the component/fragment render viewport for one story, or an authorized full page/app-shell fallback story. Best for exact default/error/loading/success states and interaction checkpoints.
- `storybook_docs`: the docs content area or a specific gallery/grid section. Best for multi-state overviews, component matrices, and curated docs-first summaries.

The owner can reject screenshots. Record `PR截图=不存在` with `PR截图原因=主人拒绝`.

## Evidence mapping

Each screenshot records:

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

- `storybook_canvas` requires `story_id_or_title`; `storybook_docs` requires `docs_entry_or_title`.
- A docs capture showing multiple states uses `scenario` to describe the gallery, for example `status matrix`.
- Component, fragment, and reusable-state evidence use `margin_policy=require_margin`, `evidence_surface=component`, and both selectors.
- Full page/app-shell fallback uses `margin_policy=trim_only` and `evidence_surface=page`.
- If the requested proof still belongs to `ui_demo` or another owner-locked non-Storybook source, return to the caller instead of reporting Storybook success.
- Do not report `视觉证据目标源=ui_demo` from this stage; that value belongs to `ui-visual-evidence` after the demo/browser path runs.

## Persistence and commits

Asset placement, Spec/Plan persistence, immutable chat snapshots, and PR body images are owned by `evidence-lifecycle.md`. This stage only produces the captured set.

Screenshot-only commits follow these rules:

- Local-review-only captures need no dedicated screenshot commit and no push.
- When PR later reuses images already committed during local review, do not require a new screenshot-only commit or history rewrite; pass the selected paths to the task-scoped PR gate.
- A dedicated commit is only for images added or replaced specifically for PR evidence after PR flow started: `chore(pr-screenshots): add visual evidence` or `chore(pr-screenshots): refresh visual evidence`, pushed separately from implementation commits and only after the same asset set was shown in chat with explicit submit approval.
- When the owner asks to replace screenshots, prefer replacing an existing dedicated screenshot phase commit only when one exists; otherwise update the task evidence declaration without rewriting history. Confirm rewrite safety before any force-push, and fall back to a new dedicated commit when it cannot be confirmed.
