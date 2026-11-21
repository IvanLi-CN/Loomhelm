---
name: ui-visual-evidence
description: "Clear the visual-evidence gate for UI and non-UI work."
---

# ui-visual-evidence

Use whenever the visual-evidence gate must be cleared before work counts as visually verified, locally ready to open a PR (`可开 PR（local）`), or local-merge-ready. That includes `UI-affecting` work needing stable rendered images and clearly non-UI work that must report `视觉证据=不适用`.

This Skill owns the whole gate, including Storybook capture. Read a reference only when entering its stage:

- render-source geometry and page trimming: `references/component-surface-preflight.md`
- viewport resolution and browser strategy: `references/viewport-ladder.md`
- `storybook_docs` / `storybook_canvas` capture, evidence mapping, asset placement, screenshot commits: `references/storybook-capture.md`
- comparison, persistence, chat snapshots, PR body images: `references/evidence-lifecycle.md`

## Applicability gate

Treat the work as `UI-affecting=yes` when ANY is true:

- the requirement or spec asks for a UI, page, screen, component, visual polish, or interaction surface;
- changed files live under UI/story/render/display paths;
- acceptance criteria are inherently visual or interaction-facing;
- the task changes Storybook stories/docs, a browser-rendered surface, an app window, or an embedded display render.

Clearly non-visual work records `视觉证据=不适用` plus `视觉证据原因=<one concrete reason>`. If you cannot decide safely, stop and ask one concise question.

## Source selection

Use the first applicable source:

1. `ui_demo`
2. `storybook_docs`
3. `storybook_canvas`
4. `mock_ui`
5. `firmware_preview`
6. `target_app_window`

Rules:

- Web components, fragments, and reusable states with Storybook present: clear `$storybook-stories` for the changed surface first, then use `storybook_canvas` when that result resolved a canvas source or the repo has a stable canvas-only convention, otherwise `storybook_docs`.
- Web pages, flows, and app shells: prefer a qualified `ui_demo` — mock-only, login-free, no real backend dependency, reproducible from repo scripts or static assets.
- Without a qualified `ui_demo`, a complete page/app-shell Storybook fallback requires an existing explicit page-level exception in owner instructions, project documentation, or the active spec. Absence of `ui_demo` alone does not authorize it; report the page evidence blocker instead.
- Mixed work: Storybook for changed components/fragments/reusable states, `ui_demo` for changed full page/flow evidence.
- Web/App UI without Storybook: prefer a deterministic mock preview or test/demo surface.
- Firmware or embedded display: prefer `$firmware-display-preview`.
- `target_app_window` is the last-resort exception and requires explicit owner confirmation of `target_program` and `capture_scope`.

## Owner source lock

An explicit final-source instruction such as `web demo`, `ui_demo`, or `not Storybook` locks that source until the owner changes it.

- A locked non-Storybook source outranks the selection order for the same evidence target. Never satisfy it with `storybook_docs`/`storybook_canvas` and report success.
- If the locked source is unavailable or non-deterministic, report `视觉证据=不存在` with a concrete `视觉证据原因`, or repair that source and capture from it.
- Storybook stays valid for components/fragments/reusable states, and for a full page/app-shell fallback only when no owner lock conflicts, no qualified `ui_demo` exists, and an explicit page-level exception authorizes it.

## Workflow

### 1) Confirm the evidence target

Identify the surface: `web_component`, `web_page`, `app_window`, `firmware_display`, or `other_visual_surface`. Capture from the current local implementation.

Resolve before capture:

- `margin_policy=require_margin` for `web_component`, component fragments, reusable states, and `mock_ui`; this selects the source-managed DOM preflight, not image normalization.
- `margin_policy=trim_only` for `ui_demo`, full page/app-shell Storybook fallback, and other page-level surfaces.
- `evidence_surface=component|page|mock_ui|app_window|firmware_display|other_visual_surface`.

For `web_page`, `app-shell`, and `page-flow`, resolve the evidence source and any owner lock before starting a browser session, per the source selection rules above.

### 2) Establish deterministic input

Prefer mock data, fixtures, or simulator inputs and reuse repo-native mock/provider patterns instead of inventing an isolated fake stack. A source that cannot render deterministically must be fixed before capture; an owner-locked source must be repaired rather than silently replaced.

### 3) Clear prerequisite coverage

- Changed Web components/fragments/reusable states with Storybook present: run `$storybook-stories` and require `Storybook覆盖=通过` before Storybook capture.
- Full Web pages/flows with a qualified `ui_demo`: report `Storybook覆盖=不适用` for page-level coverage unless changed reusable components also need Storybook, and do not require full page stories.
- Full pages/flows without `ui_demo` but with an explicit page-level exception: run `$storybook-stories` for a complete page/app-shell fallback and require `Storybook覆盖=通过`.
- Full pages/flows without `ui_demo` and without an exception, or with an unavailable owner-locked source: report the blocker instead of falling back silently.

### 4) Capture with the source path

- Before the first `$ego-browser` command, read and follow its task-space workflow.
- `ui_demo` / `mock_ui`: use `$ego-browser` for formal validation and capture; use the `chrome-devtools` exception under `$gui-escalation-gate` only when viewport emulation or element-first capture requires it.
- `storybook_docs` / `storybook_canvas`: follow `references/storybook-capture.md`.
- `firmware_preview`: use `$firmware-display-preview`.
- `target_app_window`: only after explicit owner approval.
- Limit capture to the relevant rendered surface and never capture the desktop fullscreen, unrelated windows, or use "fullscreen first, crop later".

When handing off a local preview, follow the preview route in `$gui-escalation-gate`; opening it does not complete evidence capture.

Component geometry and page trimming are defined once in `references/component-surface-preflight.md`. Viewport precedence and the browser strategy ladder are defined once in `references/viewport-ladder.md`.

### 5) Compare, persist, and return

Follow `references/evidence-lifecycle.md` for the comparison helper, `reg-cli` inspection report, owner confirmation rules, immutable chat snapshots, Spec/Plan asset placement, and the PR body image gate.

### 6) Staleness

Evidence becomes stale immediately when a new local commit, base sync, mandatory review repair, or local-merge proof changes the rendered surface or its render inputs, or when the chosen render source no longer reflects the implementation. Exception: a metadata-only evidence-persistence commit that only stores reviewed images, asset references, or legacy-block migration needs no new owner response once a current capture and comparison establish the inner UI is unchanged.

When stale, recapture and compare again. A previous confirmation applies only to the images displayed with that question.

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
- With `margin_policy=require_margin`, a failed source-managed preflight yields `视觉证据=不存在` and `空白裁剪=不适用`; state the selectors, measured margins, and concrete failure. No helper fallback is allowed.
- Never claim a locked `ui_demo`/`web demo` request was satisfied by Storybook.
- Keep the owner-facing field name `空白裁剪`. For valid component evidence use `无需裁剪` when the declared surface is captured unchanged and `已裁剪` only for DOM-geometry tightening inside that surface; use `不适用` on a component preflight blocker. Page trim-only keeps its existing `已裁剪/无需裁剪` meanings.
- Do not request confirmation for `视觉比较=一致`. For `视觉比较=需确认`, show the complete applicable image set before accepting a clear owner reply; never make the owner inspect source control identifiers or image digests.

When evidence exists, include the same final image set shown to the owner. Chat local images must use the snapshot paths returned by `snapshot_local_image.ts`, never raw repo assets, working preview files, or PR code-hosting URLs.
