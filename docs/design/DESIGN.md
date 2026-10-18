---
name: Loomhelm
description: An owner-focused project workbench for reviewing interventions and continuing task conversations.
colors:
  canvas-light: "#c9d6e6"
  canvas-dark: "#2c3656"
  surface-light: "#f6f9fff2"
  surface-dark: "#19243ef2"
  soft-light: "#e6edf6"
  soft-dark: "#26324c"
  line-light: "#899cb64d"
  line-dark: "#a0b3db38"
  ink-light: "#20314b"
  ink-dark: "#f5f7ff"
  muted-light: "#4c5c73"
  muted-dark: "#c3cce5"
  accent-light: "#305ac7"
  accent-dark: "#d1e2ff"
  accent-ink-light: "#fff"
  accent-ink-dark: "#182746"
  selected-light: "#d4e0f2"
  selected-dark: "#40506d"
  glass-light: "#f2f7ffc2"
  glass-dark: "#1b2946c9"
  material-glow-start-light: "#8ba7d2b3"
  material-glow-end-light: "#b5c9e2cc"
  material-glow-start-dark: "#7b93b633"
  material-glow-end-dark: "#a6bce02e"
  nav-bg-light: "#e3ecf8a6"
  nav-bg-dark: "#17244099"
  nav-line-light: "#899cb63d"
  nav-line-dark: "#a0b3db38"
  nav-selected-light: "#ffffffa6"
  nav-selected-dark: "#ffffff1a"
  warning-light: "#895211"
  warning-dark: "#f6d89d"
  warning-bg-light: "#f7ead5"
  warning-bg-dark: "#3b3834"
  success-light: "#285f4c"
  success-dark: "#b9e7d3"
  success-bg-light: "#deeee7"
  success-bg-dark: "#253d3c"
  danger-light: "#a72d41"
  danger-dark: "#ffb6c4"
  danger-bg-light: "#f8e5e9"
  danger-bg-dark: "#462c3d"
  highlight-light: "#ffffffc9"
  highlight-dark: "#ffffff21"
  control-line: "#7285a5"
  backdrop: "#15243a55"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "0"
  page-title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "27px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-.025em"
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "0"
rounded:
  tag: "5px"
  control: "8px"
  overlay: "12px"
  surface: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  touch-target: "44px"
components:
  button-primary:
    backgroundColor: "{colors.accent-light}"
    textColor: "{colors.accent-ink-light}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "38px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "38px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.accent-light}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "38px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger-light}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "38px"
  input-glass:
    backgroundColor: "{colors.glass-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    height: "42px"
  select-trigger:
    backgroundColor: "{colors.glass-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    height: "42px"
  select-menu:
    backgroundColor: "{colors.glass-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.overlay}"
    padding: "5px"
  segmented-control:
    backgroundColor: "{colors.soft-light}"
    textColor: "{colors.ink-light}"
    rounded: "9px"
    padding: "4px"
  check-control:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    size: "18px"
  switch-control:
    backgroundColor: "{colors.control-line}"
    textColor: "{colors.ink-light}"
    size: "34px 20px"
  status-label:
    backgroundColor: "{colors.soft-light}"
    textColor: "{colors.muted-light}"
    rounded: "{rounded.tag}"
    padding: "4px 8px"
---

# Design System: Loomhelm

## Overview

**Creative North Star: "The Live Working Desk"**

The current D01 language board treats the product as a live working desk: blue-tinted glass separates structural layers from an almost opaque reading plane, while paired light and dark roles keep the same hierarchy legible. The implementation is restrained and operational, using fine highlights, compact controls, authored line icons, and explicit states.

`design/ui-language.html` is the owner-accepted Read-mode UI language board, and `design/index.html` redirects to it. The current layout source applies the same language to the synthetic workbench, project/conversation surfaces, task list/board/graph and conversation workspace; the final browser batch records its desktop/mobile capture coverage. D, Glass / Layered and its paired light/dark roles define the language-board direction. The complete product UI, production contracts and owner layout confirmation remain separate review gates. The system is authored directly in HTML, CSS and JavaScript.

**Key Characteristics:**

- Blue-tinted glass structural layers with a readable, nearly opaque surface.
- Paired light and dark semantic roles with the same information hierarchy.
- Compact controls, authored SVG line icons, and restrained layered depth.
- Clear selection, readable fields, popup menus, and explicit feedback states.

## Colors

The board palette is a blue-tinted light/dark pair: saturated action blue carries explicit actions, pale dark-theme action blue reverses the contrast, and translucent glass is reserved for structural layers, fields, and menus.

The sidecar's synthesized OKLCH swatch ramps are inspection metadata only and are not additional application tokens. Frontmatter values remain normative, while component snippets inherit the board's semantic custom properties with standalone theme fallbacks.

### Primary

- **Action blue** (`colors.accent-light` / `colors.accent-dark`): Explicit primary actions, selection emphasis, focus, and dependency strokes.
- **Action ink** (`colors.accent-ink-light` / `colors.accent-ink-dark`): Text placed on the primary action surface in each theme.

### Neutral

- **Reading surface** (`colors.surface-light` / `colors.surface-dark`): The almost opaque plane for headers, panels, controls, and readable content.
- **Soft layer** (`colors.soft-light` / `colors.soft-dark`): Tonal separation for grouped specimens, segmented controls, and inactive states.
- **Canvas** (`colors.canvas-light` / `colors.canvas-dark`): The blue-tinted field behind the board.
- **Material glow** (`colors.material-glow-start-light` / `colors.material-glow-end-light`, `colors.material-glow-start-dark` / `colors.material-glow-end-dark`): Theme-specific values for the authored `--material-glow-start` and `--material-glow-end` background glow behind the material plane.
- **Ink and muted ink** (`colors.ink-light` / `colors.ink-dark`, `colors.muted-light` / `colors.muted-dark`): Primary text and supporting metadata.
- **Lines and highlights** (`colors.line-light` / `colors.line-dark`, `colors.highlight-light` / `colors.highlight-dark`): Fine boundaries and inset material highlights.
- **Control line** (`colors.control-line`): The shared `#7285a5` outline for fields and controls in both themes.

The light muted ink is refined to `#4c5c73` on the language board for supporting text and placeholders. This is a board-level palette refinement of the extracted language, not a new owner approval.

### State

- **Success** (`colors.success-light` / `colors.success-dark`, `colors.success-bg-light` / `colors.success-bg-dark`): Completed or positively active state labels and backgrounds.
- **Warning** (`colors.warning-light` / `colors.warning-dark`, `colors.warning-bg-light` / `colors.warning-bg-dark`): Attention and incomplete states.
- **Danger** (`colors.danger-light` / `colors.danger-dark`, `colors.danger-bg-light` / `colors.danger-bg-dark`): Error and destructive-action states.

**The Paired Theme Rule.** Keep the same semantic roles, hierarchy, and readable states in both themes; change the material values, not the information architecture.

## Typography

**Display Font:** System UI stack; this implementation has no separate display face.

**Body Font:** `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`.

**Label/Mono Font:** Labels use the system stack; code and preformatted content use `ui-monospace, SFMono-Regular, Consolas, monospace`.

**Character:** The type system is compact, quiet, and platform-native so a language board and the product surfaces it informs can scan dense operational context without losing readable prose.

### Hierarchy

- **Body** (400, 14px, 1.65): General board and product-surface prose with natural `0` letter spacing.
- **Page title** (600, 27px, 1.4): The board title and equivalent top-level surface heading.
- **Section / material title** (600, 20px, 1.45): The explicit material-and-typography section `h2` and the material plane's semantic `h3`, which share one visual title scale.
- **Specimen title** (600, 28px, 1.45): The large type sample used to show the reading hierarchy.
- **Label** (500, 12px, 1.5): Field labels, state labels, metadata, and compact controls.
- **Mono** (400, 12px, 1.7): Reserved for code, operation previews, and preformatted detail; numeric samples use system text with tabular figures.

**The System Text Rule.** Use the system stack for prose and controls, and monospace for operation previews. Apply the recorded heading tracking only to the corresponding heading role.

## Layout

The current authority is a bounded Read-mode board: material and type occupy the first viewport, followed by palette, spacing, shapes, and a compact component sheet. The desktop board is centered at a 1328px maximum with 36px vertical / 40px horizontal page padding; it compresses at 1023px and stacks at 767px. These are board layout observations, not product page composition.

The board records a 38px desktop button, 42px input and select, and 44px mobile control target. Mobile keeps the specimen order, raises text inputs to 16px, and gives inputs and selects 44px targets; select text remains 13px.

## Elevation & Depth

Depth is a hybrid of translucent tonal layers, theme-specific material glow, backdrop blur, inset highlights, and restrained ambient shadows. The reading plane is almost opaque; blur belongs to structural glass and floating menus. Selection is expressed through a surface shift, inset highlight, and small shadow rather than a permanent heavy lift. Light uses `#8ba7d2b3` to `#b5c9e2cc`; dark uses the lower-opacity `#7b93b633` to `#a6bce02e`.

### Shadow Vocabulary

- **Material shadow** (`var(--shadow)`): The restrained board plane and glass material relationship.
- **Selected control** (`0 2px 5px #10264514`): The active segmented button or selected theme option.
- **Floating menu** (`var(--shadow), inset 0 1px 0 var(--highlight)`): A select menu that reads as a front layer.

**The Layered Depth Rule.** Use tonal separation and fine highlights first; reserve ambient shadows for material planes, selected controls, and floating menus.

## Shapes

The board uses four reusable radii: 5px for labels and status chips, 8px for buttons, fields, and controls, 12px for floating menus and grouped overlays, and 16px for material and content planes. Borders are fine and often translucent; selection is reinforced by a surface shift and inset highlight rather than a thick outline. Authored line icons are 18px in controls and 14px in status or feedback labels.

## Components

### Buttons

- **Shape:** 8px radius, 38px desktop minimum height, 8px 14px padding, and a 44px mobile minimum.
- **Primary:** Action blue with theme-matched action ink for explicit committed actions.
- **Secondary / Quiet / Danger:** Transparent secondary controls use the control line; quiet actions use accent ink without a persistent border; danger uses the danger ink and line.
- **States:** Hover shifts to the soft layer, active shifts to the selected layer, focus uses a 2px accent outline with 3px offset, disabled uses the soft layer and muted ink, and busy retains the disabled geometry with a spinner.

### Inputs / Fields

- **Style:** Glass input surface, 8px radius, 42px minimum height, 10px 12px padding, and the shared `#7285a5` control line; placeholders use muted ink.
- **Search:** `type=search` receives the native search appearance and cancel-button reset while retaining the board's caret, placeholder, and focus grammar.
- **Validation:** Invalid fields use danger line plus a text-and-icon message; the name error message is `aria-live="polite"`.
- **Mobile:** Inputs and selects use 16px text and a 44px minimum target at the mobile breakpoint.

### Select Menus

- **Trigger:** The select trigger uses the input grammar at 42px desktop / 44px mobile, with an icon, value, chevron, and accent focus outline.
- **Menu:** The menu is a 12px glass overlay with 5px inset padding; options use text, selected background, and a check icon rather than color alone.
- **Keyboard:** The authored listbox supports Arrow keys, Home, End, Escape, and Tab; closing by selection, Escape, or Tab restores the trigger's focus context.

### Segmented Controls

- **Style:** A soft 9px container uses 4px padding and 3px gaps; buttons stay transparent at rest and share the compact control grammar.
- **Selected:** The active button uses the reading surface, ink, and a small selection shadow; inactive buttons remain readable through muted ink.

### Selection Controls

- **Checkbox:** An 18px control uses the shared control line, accent fill, and accent ink check; its label wrapper remains a 44px target.
- **Switch:** A 34px by 20px track uses control line at rest and accent when on; the full switch control remains a 44px target.
- **Disabled:** Disabled controls reduce contrast and preserve the reason in adjacent text rather than relying on opacity alone.

### Status and Feedback

- **Status labels:** Five-pixel labels pair short text with authored line icons; success, warning, danger, and neutral states use text plus a semantic color/background pair.
- **Content feedback:** Empty, loading, and error states each name the condition and expose the next useful action; loading may use a restrained spinner and reduced-motion fallback.

### Material and Icons

- **Material:** The canvas, frosted structural layer, fine line/highlight, and opaque reading surface are the core D grammar; glass never obscures readable content.
- **Material heading:** Keep the section heading explicit in the document outline and use a semantic `h3` for the material-plane title while retaining the board's 20px visual title scale.
- **Icons:** Use authored inline SVG line icons with `currentColor`, `18px` control sizing, and `aria-hidden="true"` when adjacent text names the action.

## Do's and Don'ts

### Do:

- **Do** keep light and dark roles paired so the same content, control, and state distinctions remain readable.
- **Do** keep the reading surface almost opaque and reserve glass blur for structural layers and floating menus.
- **Do** use authored inline SVG line icons and CSS; this board has no shipping raster UI assets.
- **Do** use 38px desktop buttons, 42px inputs/selects, and 44px mobile interactive targets.
- **Do** keep error, loading, empty, selected, disabled, busy, and focus states explicit in text, icon, or geometry.
- **Do** suppress animation and transitions when `prefers-reduced-motion: reduce` is active.

### Don't:

- **Don't** carry rejected neutral, journal, standard, or other exploratory direction rules into the selected glass system.
- **Don't** turn the prototype's queue, request, or recent-conversation arrangement into universal component guidance.
- **Don't** make reading surfaces fully transparent or use heavy permanent shadows that compete with the work.
- **Don't** apply heading tracking to prose, labels, or metadata that are not heading roles.
- **Don't** claim this board proves the complete UI, backend behavior, synchronization, authorization, or product approval.
