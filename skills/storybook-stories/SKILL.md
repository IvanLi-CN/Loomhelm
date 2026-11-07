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

## Read this reference only when needed

- State coverage matrix and docs layout guidance: [references/state-coverage.md](./references/state-coverage.md)

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

### 4) Choose deterministic file locations

For a source file `X`:

- if the target area already has co-located stories/docs, keep them co-located;
- else if the repo clearly uses a central stories/docs directory, use that directory;
- else default to co-locating next to `X`.

All chosen paths must match the configured story globs in `.storybook/main.*`.

If a docs page is required:

- prefer the repo's existing docs style;
- if the repo uses MDX docs pages, create/update an MDX page near the target;
- if the repo uses autodocs/custom docs in stories, update the story file accordingly instead of forcing MDX.

### 5) Create or update stories with strong default coverage

Always prefer the repo's existing syntax and patterns.

For `component` or `fragment`, default to covering the applicable major states from the reference matrix, for example:

- default/resting
- disabled
- loading or skeleton
- empty or missing-content
- error or destructive
- success/positive
- selected/active
- hover/focus only when the repo already documents pseudo-state visuals this way

For `page-fallback`, cover the complete page/app-shell states required for acceptance, for example:

- happy path
- loading/skeleton
- empty
- error/failure fallback
- auth/permission/forbidden
- partial data or degraded mode

Do not treat this as permission to invent irrelevant states. Only include states that make sense for the target and its acceptance criteria.

Each docs-exposed state should still map back to a stable, independently addressable story.

### 5.1) Provide a source-managed presentation surface when component evidence is selected

Only the Story/docs entry selected for component, fragment, or reusable-state evidence needs this contract. Do not add a generic screenshot wrapper to every Story.

- The outer source element declares `data-visual-evidence-surface`; the contained evidence boundary declares `data-visual-evidence-target`.
- Pass stable selectors for those two declared elements to `$storybook-screenshots`. The target must include every visible component effect, including any intentional shadow or overflow that belongs to the component.
- The surface owns the component's real outer margin. Its computed background is one opaque, uniform, solid theme color already natural to that Story; it is not an evidence-only swatch.
- The surface must not introduce a border, radius, shadow, gradient, image background, new card boundary, or nested-card presentation. It should read as the Story's natural canvas, not a frame around the component.
- Choose the real spacing deliberately. `$storybook-screenshots` measures it once as `clamp(round(long_edge * 0.02), 16, 48)` px and accepts each side only within that range; do not add padding when existing component spacing already satisfies it.
- Keep the target fully inside the surface. If it cannot be made compliant naturally, report the Storybook blocker instead of relying on screenshot-time padding, style changes, or image analysis.
- This contract does not require a `play` function, test configuration, CI assertion, stored measurement receipt, or owner-facing measurement field.

### 5.2) Encode viewport-dependent scenarios into the selected evidence source

- Resolve mobile viewport precedence from owner, project, spec, and the selected source. When none defines a size, use `393x852` CSS px and bind it to the Storybook story/docs surface selected for evidence.
- If acceptance or later visual evidence depends on a specific mobile/tablet/desktop size, create or update a stable `ui_demo` scenario or authorized Storybook fallback entry that already expresses that viewport or responsive scenario.
- For Storybook fallback, prefer the repo's existing Storybook viewport conventions first (`globals.viewport`, `parameters.viewport`, named viewport presets, or an equivalent repo-native surface).
- If the selected source does not expose viewport presets, still make the responsive scenario discoverable through a clearly named scenario instead of telling downstream capture to resize the browser window ad hoc.
- Later screenshot flows must be able to verify and carry `requested_viewport` from the selected evidence surface itself; when the default applies, record `requested_viewport=393x852`.

### 6) Docs are required when the repo supports them

For components/fragments:

- provide a docs-first overview page that shows multiple major states together;
- docs should be optimized for visual scanning, not for tweaking knobs;
- default to a static gallery/grid layout, usually 1-3 columns depending on viewport and state count.

For `page-fallback` stories:

- provide a docs page that explains the main scenarios and presents the complete page states or flows needed for acceptance;
- when it helps clarity, group stories by scenario instead of by prop permutation.
- when the work is mainly about reviewing multiple visual states in one place, prefer a single curated state gallery/docs surface over many standalone state stories.
- keep sidebar noise low: do not create a separate story for every purely presentational state if those states are already covered well inside the gallery.
- retain standalone stories only when they add durable value outside the gallery, such as interaction-specific `play` coverage, reusable entry points for debugging, or flows that benefit from isolated review.

Docs defaults:

- prefer Storybook docs blocks, autodocs, or MDX in the repo's existing style;
- do not default to a controls-heavy playground;
- if Controls are already part of the repo convention, keep them available, but the docs page should still read as a curated overview rather than a sandbox.

### 7) Add `play` coverage where behavior matters

Default expectation:

- `page-fallback`: include `play` coverage for key acceptance behavior, usually at least 1 happy path and 1 key negative/boundary path when those behaviors exist
- interactive `component` / `fragment`: add `play` when it validates real behavior, not just rendering
- purely static leaf UI: `play` is optional

Use the repo's existing testing patterns first:

- `play`
- `beforeEach`
- `storybook/test`
- args spies, mocked modules, mock data factories
- router/provider wrappers already used elsewhere

Use `play` to validate things Storybook is good at:

- interaction sequences
- state transitions
- mocked data loading
- permission/auth branches
- validation or failure messaging

### 8) Verify with repo-native checks

Determine package manager by lockfile:

- `pnpm-lock.yaml` => `pnpm`
- `yarn.lock` => `yarn`
- otherwise => `npm`

Preferred Storybook checks: run the first available script in `package.json`:

1. `test-storybook`
2. `storybook:ci`
3. `build-storybook`

If none exist, run the repo's standard typecheck/lint steps that compile stories/docs.

If visual verification is needed:

- treat Storybook as a long-lived local service;
- lease/verify the port via `$global-port-manager` before startup;
- if the goal is same-turn browser verification only, a `live exec preview` via Codex native background terminals is acceptable;
- if the goal includes owner-facing localhost handoff or a stable review URL, the Agent must obtain and retain a Codex native background terminal/session for the current workspace, register the host-provided `agent_session` when available, and do not hand off a URL still tied only to a foreground live exec; the Skill does not create, infer or replace that host session, so a missing supported background route is a handoff blocker;
- for browser validation, use `$ego-browser` in one task-scoped TaskSpace.

### 9) Final delivery report

Always include:

- `Storybook覆盖:` `通过|阻断|不适用|未检查`
- `视觉证据目标源:` `storybook_docs|storybook_canvas|ui_demo|未确定`
- `Stories:` list of added or updated story files
- `Docs pages:` list of added or updated Storybook docs entries, or `none (reason: ...)`
- `Play coverage:` list of new or updated interactive stories/tests, or `none (reason: ...)`
- `Storybook checks:` scripts run, or `not available`
- `Stories skipped:` only when something expected was intentionally skipped, with an explicit reason
