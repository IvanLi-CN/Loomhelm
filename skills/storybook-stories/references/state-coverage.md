# Storybook state coverage and docs layout

Load this reference when a UI task needs stronger guidance on what Storybook should cover.

## State coverage defaults

Use the repo's real UI semantics. Do not force every target into the full list.

### Component / fragment

Start from these common candidates and keep only the states that matter:

- default/resting
- hover/focus/pressed when the repo already documents pseudo states
- disabled
- selected/active
- loading/skeleton
- empty/no-value
- success/positive
- warning/caution
- error/destructive

For small visual primitives, a compact gallery of 3-8 states is usually enough.

### Page / app shell

Default scenario set:

- happy path
- loading/skeleton
- empty
- error/failure fallback
- auth/permission branch
- partial data/degraded mode when applicable

For forms or multi-step flows, also consider:

- pristine/default
- validation error
- submitting
- submitted/success

## Docs layout defaults

Docs pages should read like a curated UI review surface, not a playground.

Preferred layout:

- 1 column for pages or tall flows
- 2-3 columns for component or fragment galleries
- stable labels per state
- minimal prose: enough to explain scenarios, not enough to distract from the UI

Prefer:

- static presentation of the important states
- grouping by scenario or semantic meaning
- stable story-backed entries with unique URLs

Avoid as the default:

- giant controls-first playgrounds
- pages that only show one `Default` story and call it documentation
- exhaustive prop matrixes that are hard to scan and weakly tied to product behavior

## Interaction coverage defaults

Use `play` when the behavior is worth proving:

- clicks that change state
- async loading completion
- validation errors
- permission or auth gating
- save/submit flows

Skip `play` only when the target is effectively static and the extra test would add no confidence.
