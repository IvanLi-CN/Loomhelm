# Source-managed component surface preflight

This is the single definition of component evidence geometry. `$storybook-stories` authors the surface; capture verifies it once.

## Surface contract

A component, fragment, reusable state, or `mock_ui` source selected as evidence must declare `[data-visual-evidence-surface]` around `[data-visual-evidence-target]`.

- The target covers all visible component effects, including intentional shadow and overflow that belong to the component.
- The surface owns the component's real outer margin and uses one opaque, uniform, solid background from the active theme.
- The surface must not add border, radius, shadow, gradient, image background, evidence-only color, a card boundary, or nested-card presentation. Do not add spacing when the component and its natural canvas already provide a compliant margin.

## Measurement

Run one DOM preflight only: read the declared selectors, target/surface rectangles, containment, overflow, and computed styles.

- `required_margin = clamp(round(long_edge * 0.02), 16, 48)` computed from the target rectangle.
- Measure left, top, right, and bottom target-to-surface margins once. Every side must be at least `required_margin` and at most `48px`.
- When a side exceeds `48px`, tighten only the capture rectangle within the declared surface from known DOM geometry, retaining `48px` on that side.
- Never analyze pixels, inject a wrapper, mutate the DOM, change CSS, add synthetic padding, infer a background, or save a measurement receipt.

## Blocking conditions

Block component evidence and return the source work to `$storybook-stories` when any is true:

- either selector is absent;
- the surface is transparent or visually framed;
- the target escapes the surface;
- a side is below `required_margin`;
- no natural opaque theme surface can be established.

Report the selectors, rectangles, computed-style failure, and per-side margins as the reason. There is no helper fallback: `trim_whitespace.ts --margin-policy=require_margin` is a compatibility input that always returns `blocked` with `source_managed_surface_required`.

## Page surfaces

`ui_demo` and full page/app-shell Storybook fallback use `margin_policy=trim_only` instead: `skills/ui-visual-evidence/scripts/trim_whitespace.ts --margin-policy=trim_only` may trim edge-connected excess whitespace while preserving `clamp(round(long_edge * 0.02), 16, 48)` px. Ambiguous borders and already-tight pages retain the original image. `firmware_preview` and `target_app_window` stay outside automatic whitespace handling.
