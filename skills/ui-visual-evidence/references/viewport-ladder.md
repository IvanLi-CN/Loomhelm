# Viewport-safe capture ladder

## Precedence

Resolve the requested CSS viewport in this order:

1. owner-explicit size;
2. project, spec, or selected-source-defined size;
3. default `393x852` CSS px.

A Storybook story or demo scenario that already binds a viewport counts as source-defined and must not be replaced by the default. Treat `393x852` as a deterministic responsive-review viewport, not a physical-pixel resolution or a user-agent emulation. Record `requested_viewport=393x852` whenever the default applies.

`requested_viewport` and `viewport_strategy` travel with the chosen evidence source.

## Ladder

- `ui_demo` => source-managed demo scenario (`viewport_strategy=ui-demo-source`) when available, otherwise `viewport_strategy=devtools-emulate` + element-first capture.
- `storybook_docs` / `storybook_canvas` => source-managed viewport (`viewport_strategy=storybook-viewport`) + element-first capture.
- `mock_ui` => `viewport_strategy=devtools-emulate` + element-first capture.
- `capture_scope=browser-viewport` only when the whole rendered browser area is itself the evidence target.
- `browser-resize-fallback` only after the normal path cannot produce the requested proof.

Never choose browser window resize as the initial plan for Storybook, `ui_demo`, or `mock_ui` evidence. `devtools-emulate` here is a narrow `chrome-devtools` evidence-capture exception under `$gui-escalation-gate`, not the default general browser route.

Before recording a `393x852` fallback, bind the selected surface to it and prove the rendered viewport. Storybook must use a stable viewport-bound story/docs surface and return to `$storybook-stories` when one is missing.

If `browser-resize-fallback` is used, record why the normal path failed and restore the original browser window size before handoff. Failed restoration blocks the evidence flow instead of handing off mutated browser state.
