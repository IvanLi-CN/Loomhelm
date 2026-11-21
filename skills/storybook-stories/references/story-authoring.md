# Story authoring

Authoring detail for `$storybook-stories`. Load when writing or updating stories, docs pages, or `play` coverage.

## States

Always prefer the repo's existing syntax and patterns, and cover only states that make sense for the target and its acceptance criteria. The common candidate matrix per surface type lives in `state-coverage.md`; do not treat it as permission to invent irrelevant states.

- `component` / `fragment`: state matrix + docs gallery.
- `page-fallback`: the complete page/app-shell states required for acceptance.
- Every docs-exposed state maps back to a stable, independently addressable story.

## File placement

For a source file `X`:

- if the target area already has co-located stories/docs, keep them co-located;
- else if the repo clearly uses a central stories/docs directory, use it;
- else co-locate next to `X`.

All paths must match the configured story globs in `.storybook/main.*`.

When a docs page is required, prefer the repo's existing docs style: MDX page near the target when the repo uses MDX, otherwise update the story's autodocs/custom docs instead of forcing MDX.

## Docs surface

For components and fragments, provide a docs-first overview that shows multiple major states together, optimized for visual scanning rather than knob-tweaking: static gallery/grid layout, usually 1-3 columns by viewport and state count.

For `page-fallback`, explain the main scenarios and present the complete page states or flows needed for acceptance; group by scenario rather than prop permutation. When the work is mainly reviewing multiple visual states in one place, prefer a single curated state gallery over many standalone state stories. Keep sidebar noise low, and retain standalone stories only when they add durable value outside the gallery, such as interaction-specific `play` coverage, reusable debugging entry points, or flows that benefit from isolated review.

Docs defaults: prefer Storybook docs blocks, autodocs, or MDX in the repo's existing style; do not default to a controls-heavy playground. If Controls are already repo convention, keep them available, but the docs page should still read as a curated overview.

## `play` coverage

- `page-fallback`: cover key acceptance behavior, usually at least one happy path and one key negative or boundary path.
- Interactive `component` / `fragment`: add `play` when it validates real behavior rather than rendering.
- Purely static leaf UI: `play` is optional.

Use the repo's existing patterns first: `play`, `beforeEach`, `storybook/test`, args spies, mocked modules, mock data factories, and existing router/provider wrappers. Use `play` for what Storybook is good at: interaction sequences, state transitions, mocked data loading, permission or auth branches, and validation or failure messaging. `state-coverage.md` lists interaction defaults.

## Verification

Determine the package manager by lockfile: `pnpm-lock.yaml` => `pnpm`, `yarn.lock` => `yarn`, otherwise `npm`.

Run the first available Storybook script in `package.json`: `test-storybook`, `storybook:ci`, then `build-storybook`. If none exist, run the repo's standard typecheck/lint steps that compile stories and docs.

For visual verification:

- treat Storybook as a long-lived local service and lease or verify the port through `$global-port-manager` before startup;
- same-turn browser verification may use a `live exec preview` through Codex native background terminals;
- owner-facing localhost handoff or a stable review URL requires a retained native background terminal/session for the current workspace, with `agent_session` registered when the host exposes it. Never hand off a URL tied only to a foreground live exec, and never invent or replace the host session — a missing supported background route is a handoff blocker;
- formal browser validation uses `$ego-browser` in one task-scoped TaskSpace;
- opening a local Storybook preview for the owner follows the preview route in `$gui-escalation-gate`.
