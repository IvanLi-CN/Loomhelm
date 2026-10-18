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
  muted-light: "#52637a"
  muted-dark: "#c3cce5"
  accent-light: "#305ac7"
  accent-dark: "#d1e2ff"
  accent-ink-light: "#fff"
  accent-ink-dark: "#182746"
  selected-light: "#d4e0f2"
  selected-dark: "#40506d"
  glass-light: "#f2f7ffc2"
  glass-dark: "#1b2946c9"
  nav-bg-light: "#e3ecf8a6"
  nav-bg-dark: "#17244099"
  nav-line-light: "#899cb63d"
  nav-line-dark: "#a0b3db38"
  nav-selected-light: "#ffffffa6"
  nav-selected-dark: "#ffffff1a"
  warn-light: "#895211"
  warn-dark: "#f6d89d"
  warn-bg-light: "#f7ead5"
  warn-bg-dark: "#3b3834"
  active-light: "#285f4c"
  active-dark: "#b9e7d3"
  active-bg-light: "#deeee7"
  active-bg-dark: "#253d3c"
  highlight-light: "#ffffffc9"
  highlight-dark: "#ffffff21"
  field-border-light: "#8195b3"
  field-border-dark: "#7285a5"
  backdrop: "#15243a55"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "0"
  mobile-body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "0"
  page-title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-.03em"
  task-title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "21px"
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
  control: "8px"
  selected-row: "10px"
  panel: "12px"
  segment: "9px"
  shell: "16px"
spacing:
  control: "8px"
  inset: "16px"
  panel: "20px"
  section: "24px"
  heading: "28px"
  content: "32px"
  touch-target: "44px"
components:
  button-primary:
    backgroundColor: "{colors.accent-light}"
    textColor: "{colors.accent-ink-light}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
    height: "36px"
  input-glass:
    backgroundColor: "{colors.glass-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.control}"
    padding: "9px 10px"
  navigation-sidebar:
    backgroundColor: "{colors.nav-bg-light}"
    textColor: "{colors.ink-light}"
    width: "248px"
    padding: "24px 14px 12px"
  attention-row-selected:
    backgroundColor: "{colors.selected-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.selected-row}"
    padding: "16px"
  request-panel:
    backgroundColor: "{colors.soft-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.panel}"
    padding: "24px"
  segmented-control:
    backgroundColor: "{colors.soft-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.segment}"
    padding: "4px"
  composer:
    backgroundColor: "{colors.glass-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.panel}"
    padding: "12px 16px"
  task-info-rail:
    backgroundColor: "{colors.soft-light}"
    textColor: "{colors.ink-light}"
    width: "292px"
    padding: "26px 22px"
  conversation-title:
    backgroundColor: "transparent"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.control}"
    padding: "0"
    height: "32px"
---

# Design System: Loomhelm

## Overview

**Creative North Star: "The Live Working Desk"**

Loomhelm's selected D, Glass / Layered direction treats the workbench as a live working desk: blue-tinted frosted navigation and chrome surround an almost opaque reading plane, while the same hierarchy remains legible in light and dark themes. The implementation is restrained and operational, using fine highlights, compact controls, authored line icons, and explicit states to keep intervention review and conversation work in context.

This document extracts reusable visual rules from the current D01 workbench and task-workspace review master. The owner selected the Glass / Layered material direction and its light/dark specimens; complete page design remains subject to review. Page composition and prototype behavior belong to the surface brief rather than the reusable visual system.

**Key Characteristics:**

- Blue-tinted glass navigation and chrome with a readable, nearly opaque surface.
- Paired light and dark semantic roles with the same information hierarchy.
- Compact controls, authored SVG line icons, and restrained layered depth.
- Clear selection, readable request context, and expandable conversation details.

## Colors

The palette is a blue-tinted light/dark pair: saturated action blue carries explicit actions, pale dark-theme action blue reverses the contrast, and translucent glass is reserved for chrome and input surfaces.

The sidecar includes synthesized OKLCH swatch ramps for inspection only. They are not additional application tokens; the frontmatter values remain normative. Its component snippets inherit the master's semantic custom properties, with standalone theme fallbacks.

### Primary

- **Action blue** (`colors.accent-light` / `colors.accent-dark`): Explicit primary actions, selection emphasis, focus, and dependency strokes.
- **Action ink** (`colors.accent-ink-light` / `colors.accent-ink-dark`): Text placed on the primary action surface in each theme.

### Neutral

- **Reading surface** (`colors.surface-light` / `colors.surface-dark`): The almost opaque plane for headers, panels, controls, and readable content.
- **Soft layer** (`colors.soft-light` / `colors.soft-dark`): Tonal separation for request panels, task information, message blocks, and segmented controls.
- **Canvas** (`colors.canvas-light` / `colors.canvas-dark`): The blue-tinted background behind the work area.
- **Ink and muted ink** (`colors.ink-light` / `colors.ink-dark`, `colors.muted-light` / `colors.muted-dark`): Primary text and supporting metadata.
- **Lines and highlights** (`colors.line-light` / `colors.line-dark`, `colors.highlight-light` / `colors.highlight-dark`): Fine boundaries and inset material highlights.

### State

- **Attention** (`colors.warn-light` / `colors.warn-dark`, `colors.warn-bg-light` / `colors.warn-bg-dark`): Pending approval, unresolved results, and other attention states.
- **Active** (`colors.active-light` / `colors.active-dark`, `colors.active-bg-light` / `colors.active-bg-dark`): Running or positively active state labels and backgrounds.

**The Paired Theme Rule.** Keep the same semantic roles, hierarchy, and readable states in both themes; change the material values, not the information architecture.

## Typography

**Display Font:** System UI stack; this implementation has no separate display face.

**Body Font:** `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`.

**Label/Mono Font:** Labels use the system stack; code and preformatted content use `ui-monospace, SFMono-Regular, Consolas, monospace`.

**Character:** The type system is compact, quiet, and platform-native so the workbench can scan dense operational context without losing readable prose.

### Hierarchy

- **Body** (400, 14px, 1.7): General workbench and workspace text; the root becomes 15px at the mobile breakpoint.
- **Page title** (600, 26px, 1.4): The selected glass workbench page heading.
- **Task title** (600, 21px, 1.4): The desktop task or conversation workspace heading.
- **Label** (500, 12px, 1.5): Navigation metadata, state labels, and compact controls.
- **Mono** (400, 12px, 1.7): Operation previews and tool-detail content.

**The System Text Rule.** Use the system stack for prose and controls, and monospace for operation previews. Apply the recorded heading tracking only to the corresponding heading role.

## Layout

The selected desktop workbench uses a 248px project/conversation navigation column and a work area with a 56px context bar; the work area sits inside 12px outer margins with a 16px shell radius. Content uses 32px padding and the D01 triage slice uses a maximum 1180px grid with queue and request columns plus a recent-conversation row. The task workspace uses a 292px information rail beside the main conversation.

At 79.99rem the content inset becomes 26px and the triage gap becomes 24px; at 63.99rem the sidebar is hidden and the work area uses a 10px margin; at 47.99rem the layout becomes a single queue, request, recent reading order, task information becomes a task-local panel, and content uses 24px vertical / 16px horizontal padding. These values describe this D01 slice, not a universal fixed page composition.

## Elevation & Depth

Depth is a hybrid of translucent tonal layers, backdrop blur, inset highlights, and restrained ambient shadows. The reading plane is almost opaque; blur belongs to navigation, chrome, the composer, dialogs, and the mobile navigation drawer. The selected request plane settles through a brief opacity/shadow response rather than a permanent heavy lift.

### Shadow Vocabulary

- **Shell shadow** (`0 12px 36px #344e731c` light; `0 12px 36px #08112640` dark): The outer work area and preview shell.
- **Navigation selection** (`inset 0 1px 0 var(--highlight), 0 3px 9px #1b34530c`): A current navigation item with a fine top highlight and almost imperceptible lift.
- **Segment selection** (`0 2px 5px #10264514, inset 0 1px 0 var(--highlight)`): The active view or task panel inside a tonal segmented control.
- **Composer shadow** (`0 6px 20px #1026450a`): The floating shared-draft composer.

**The Layered Depth Rule.** Use tonal separation and fine highlights first; reserve ambient shadows for a shell, selected control, settling response, or composer that needs to read as a front layer.

## Shapes

The selected glass language uses gentle but compact corners: 8px controls and fields, 9px segmented controls, 10px selected queue rows, graph nodes and user messages, 12px request/composer panels, and 16px work shells and dialogs. Borders are fine and often translucent; selection is reinforced by a surface shift and inset highlight rather than a thick outline. Authored line icons are 18px in controls and 12px for navigation disclosure marks.

## Components

### Buttons

- **Shape:** Compact 8px controls with a 36px desktop minimum height and 7px 12px padding.
- **Primary:** Action blue with theme-matched action ink; used for explicit approval, send, create, and other committed actions.
- **Hover / Focus:** Primary hover uses a small brightness reduction; general hover shifts to the soft layer; focus uses a 2px outline with 3px offset and the theme focus color.
- **Secondary / Quiet / Disabled:** Secondary controls use the reading surface and fine line; quiet controls are transparent until hover; disabled controls use the soft layer, muted ink, and reduced opacity.

### Cards / Containers

- **Request panel:** Soft layer, 12px radius, 24px padding, and an inset top highlight for the selected operation context.
- **Attention row:** Transparent at rest, 10px radius, 16px padding, and a selected soft-blue layer with an inset highlight.
- **Task information rail:** Soft layer, 292px desktop width, and 26px vertical / 22px horizontal padding.
- **Shell:** Reading surface, 16px radius, 12px outer margin, and the shell shadow vocabulary above.

### Inputs / Fields

- **Style:** Glass input surface, 8px radius, 9px 10px padding, and the dedicated field border; placeholders use muted ink.
- **Focus:** The accent/focus color is used for the visible focus outline and caret.
- **Mobile:** Inputs, selects, and textareas use 16px text at the mobile breakpoint; the shared composer textarea remains transparent inside its glass container.

### Navigation

- **Style:** A 248px frosted sidebar uses 22px blur, a fine inset divider, 24px top / 14px side padding, 9px 10px navigation rows, and 18px line icons.
- **Active:** The current entry uses a translucent selected surface, an inset top highlight, and minimal ambient lift.
- **Mobile:** The sidebar becomes a 328px maximum-width navigation drawer with a 28px blur and a right-side 16px radius; the work area keeps the same hierarchy.

### Segmented Controls

- **Style:** View, project, and task panel switches use a soft 9px container with 4px padding and 4px gaps.
- **Selected:** The active button uses the reading surface, ink, and the segment shadow; inactive buttons remain transparent.

### Shared Draft Composer

- **Style:** The composer is a 20px inset glass panel with 12px 16px padding, 12px radius, 20px blur, a fine border, and the composer shadow.
- **Behavior:** The textarea is transparent and the action row is separated by a fine top rule; mobile reduces the outer margin and retains large touch controls.

### Conversation Titles

- **Target:** Recent conversation title buttons and all conversation list title buttons use a 32px desktop minimum and a 44px mobile target.

### Attention Labels

- **Style:** Compact 11px text on the paired attention background, 5px corners and 3px 8px padding. The label names the state; color reinforces it.

## Do's and Don'ts

### Do:

- **Do** keep light and dark roles paired so the same queue, request, conversation, and task states remain readable.
- **Do** keep the reading surface almost opaque and reserve glass blur for surrounding chrome and the shared composer.
- **Do** use authored inline SVG line icons and CSS; this slice has no shipping raster UI assets.
- **Do** keep mobile interactive targets at the observed 44px minimum for buttons, recent titles, and conversation list titles.
- **Do** suppress the request settling animation when `prefers-reduced-motion: reduce` is active.

### Don't:

- **Don't** carry the rejected neutral, journal, standard, or other exploratory direction rules into the selected glass system.
- **Don't** turn the D01 queue/request/recent arrangement into universal page composition guidance.
- **Don't** make reading surfaces fully transparent or use heavy permanent shadows that compete with the work.
- **Don't** apply heading tracking to conversation prose or compact metadata.
- **Don't** claim this slice proves the complete UI, backend behavior, synchronization, authorization, or product approval.
