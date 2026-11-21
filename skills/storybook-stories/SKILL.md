---
name: storybook-stories
description: "Add or update Storybook stories, docs pages, interaction coverage, and evidence surfaces."
---

# Storybook stories

Use this skill when a repo already uses Storybook and the task changes UI components, fragments, reusable visual states, or an explicitly authorized page/app-shell fallback is needed because no qualified `ui_demo` exists.

## Goal

Treat Storybook as the primary UI delivery surface for components, fragments, and reusable visual states:

- New or changed UI component/fragment => update stories and a docs-first state gallery.
- Page-internal UI that has independent state, interaction, or reuse value => prefer extracting it into a component/fragment and updating Storybook.
- Low-value one-off page glue such as pure layout, copy, or non-interactive composition can be covered by `ui_demo` page evidence without a new Storybook entry.
- New or changed full pages/flows => default visual evidence comes from a stable `ui_demo`, not a page story.
- If no qualified `ui_demo` exists, do not infer permission from its absence. A full page/app-shell Storybook fallback is allowed only when an existing owner, project, or active-spec exception explicitly authorizes it, and it should cover the complete page plus key `play` behavior.
- A locked non-Storybook page/flow source does not block component coverage here, but it does block Storybook from being reported as the final full-page evidence.
- If Storybook exists, do not stop at a single `Default` story unless the target is truly trivial and static.

## Definition of Done (guardrail)

1. If Storybook is detected, every new or changed UI component/fragment/reusable visual state has matching Storybook coverage.
2. Coverage means the applicable combination of:
   - stories for major states;
   - a docs page that presents those states in a browseable layout;
   - `play` interaction coverage for interactive UI and fallback page/app-shell stories.
3. If any expected artifact is skipped, the final report must explicitly say why.
4. For page/flow visual evidence, prefer a stable `ui_demo` and report `视觉证据目标源=ui_demo` from `$ui-visual-evidence`.
5. If no qualified `ui_demo` exists and an existing owner, project, or active-spec exception authorizes a page/app-shell Storybook fallback, the fallback must represent the complete page and expose key acceptance behavior through `play`; otherwise report the page evidence blocker.
6. If acceptance depends on a specific responsive viewport, the selected evidence source (`ui_demo` or Storybook fallback) must expose a stable entry that already carries that viewport or scenario instead of relying on later browser-window resizing.
7. If mobile acceptance has no owner, project, spec, or selected-source viewport, the Storybook surface used for evidence must bind and verify the default `393x852` CSS px viewport.
8. A Story selected for component evidence provides its own presentation surface; this is an evidence-source contract, not additional `play`, test, or CI coverage.

## References

Read only when entering the matching step:

- authoring, docs layout, `play`, verification: `references/story-authoring.md`
- state matrix defaults: `references/state-coverage.md`
- evidence surface and viewport binding: `references/evidence-surface.md`

## Workflow

### 1) Detect Storybook and docs capability

Treat Storybook as present if ANY is true:

- a `.storybook/` directory exists;
- `package.json` contains `@storybook/` dependencies;
- `package.json` contains Storybook-related scripts such as `storybook`, `build-storybook`, `test-storybook`, or `storybook:ci`.

If Storybook is not detected:

- report `No Storybook detected; skipping stories`
- report `Storybook覆盖=不适用`
- do not create any story/docs files

Then determine docs capability. Treat docs as available if ANY is true:

- Storybook config or dependencies include docs/autodocs/MDX support;
- existing repo stories already use `.mdx`, docs pages, or autodocs tags;
- the repo has Storybook doc blocks or docs-specific entries under its story globs.

If Storybook is present but docs capability is missing:

- do not silently fall back to ad-hoc browser screenshots;
- inspect the repo's existing Storybook version and conventions;
- if the repo already uses stable story/canvas-only conventions, extend that existing path and use `storybook_canvas` as the evidence target;
- only report `Storybook覆盖=阻断` when neither docs capability nor a stable canvas-story path can provide controlled evidence.

### 2) Discover repo conventions before writing anything

Inspect:

- story files: `rg --files -g"*.stories.*" -g"*.mdx" .`
- Storybook config: `.storybook/main.*`, `.storybook/preview.*`
- representative files near the target area: open 1-3 nearby stories/docs entries

Follow the repo's existing conventions:

- file placement: co-located vs central stories dir
- format: CSF, CSF + autodocs, or MDX docs
- typing style: `StoryObj`, `satisfies`, framework-specific meta helpers
- title naming and folder hierarchy
- decorators/providers, routing wrappers, feature flags, mock providers
- mock/data patterns already used for stories or tests

Do not invent a parallel Storybook style just for the task at hand.

### 3) Classify the target so coverage matches the UI surface

Use one of these buckets:

- `component`: reusable leaf or composed component
- `fragment`: a small composed UI slice that exists to show multiple related states together
- `page`: a route-level screen or form flow; default evidence source is `ui_demo`
- `app-shell`: a larger shell, layout, or multi-pane surface; default evidence source is `ui_demo`
- `page-fallback`: a full page/app-shell Storybook fallback used only when no qualified `ui_demo` exists and an existing owner, project, or active-spec exception authorizes it

This classification drives the minimum coverage expectation:

- `component` / `fragment`: state matrix + docs gallery
- `page` / `app-shell`: no default page story; use stable `ui_demo` for visual evidence and extract independently valuable UI into component/fragment stories
- `page-fallback`: complete page story/docs surface + key `play` coverage
- `page-fallback` is valid only when no qualified `ui_demo` exists, an existing owner, project, or active-spec exception explicitly authorizes it, and no owner-locked non-Storybook source conflicts with that fallback.

Existing page-level stories are not the preferred long-term expansion path. If a task touches an area with existing page stories, update them only as much as needed to avoid stale/broken Storybook coverage; prefer `ui_demo` for new full-page visual evidence.

### 4) Author stories, docs, and `play` coverage

Follow `references/story-authoring.md` for file placement, the state matrix, docs-first gallery, `play` coverage, and repo-native verification.

### 5) Provide evidence surfaces when selected

Follow `references/evidence-surface.md` for the source-managed presentation surface and viewport-bound scenarios. Only the selected evidence entry needs it.

### 6) Final delivery report

Always include:

- `Storybook覆盖:` `通过|阻断|不适用|未检查`
- `视觉证据目标源:` `storybook_docs|storybook_canvas|ui_demo|未确定`
- `Stories:` list of added or updated story files
- `Docs pages:` list of added or updated Storybook docs entries, or `none (reason: ...)`
- `Play coverage:` list of new or updated interactive stories/tests, or `none (reason: ...)`
- `Storybook checks:` scripts run, or `not available`
- `Stories skipped:` only when something expected was intentionally skipped, with an explicit reason
