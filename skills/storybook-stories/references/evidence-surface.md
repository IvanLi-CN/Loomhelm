# Evidence surface for stories

Contract for Stories and docs entries selected as visual-evidence sources. Only the selected entry needs it; do not add a generic screenshot wrapper to every Story.

## Source-managed presentation surface

- The outer source element declares `data-visual-evidence-surface`; the contained evidence boundary declares `data-visual-evidence-target`.
- Pass both stable selectors to `$ui-visual-evidence` capture. The target includes every visible component effect, including intentional shadow or overflow.
- The surface owns the component's real outer margin. Its computed background is one opaque, uniform, solid theme color already natural to that Story — not an evidence-only swatch.
- The surface must not introduce a border, radius, shadow, gradient, image background, new card boundary, or nested-card presentation. It reads as the Story's natural canvas, not a frame around the component.
- Choose the real spacing deliberately. Capture measures it once under `$ui-visual-evidence` `references/component-surface-preflight.md`; do not add padding when existing component spacing already satisfies it.
- Keep the target fully inside the surface. If it cannot be made compliant naturally, report the Storybook blocker instead of relying on capture-time padding, style changes, or image analysis.
- This contract requires no `play` function, test configuration, CI assertion, stored measurement receipt, or owner-facing measurement field.

## Viewport-dependent scenarios

- Resolve the mobile viewport with the precedence owned by `$ui-visual-evidence` `references/viewport-ladder.md` (owner, project, spec, selected source, then its default). Bind the resolved size to the selected Storybook story/docs surface.
- When acceptance or later visual evidence depends on a specific mobile, tablet, or desktop size, create or update a stable `ui_demo` scenario or authorized Storybook fallback entry that already expresses that viewport or responsive scenario.
- For Storybook fallback, prefer the repo's existing viewport conventions first: `globals.viewport`, `parameters.viewport`, named viewport presets, or an equivalent repo-native surface.
- If the selected source exposes no viewport presets, make the responsive scenario discoverable through a clearly named scenario instead of telling downstream capture to resize the browser window ad hoc.
- Capture must be able to verify and carry `requested_viewport` from the selected surface itself.
