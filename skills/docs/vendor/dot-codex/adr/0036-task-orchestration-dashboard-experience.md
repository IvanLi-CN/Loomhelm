# ADR 0036: Task Orchestration Dashboard Experience

- Status: Superseded
- Superseded by: `docs/adr/0041-task-orchestration-dashboard-experience.md`
- Date: 2026-10-31
- Related: `docs/adr/0035-task-orchestration-ledger.md`, `docs/specs/multi-task-flow/SPEC.md`

## Context

The task-orchestration dashboard serves two different owner jobs. Before any real task starts, the owner primarily checks whether the dependency plan is sound. After execution starts, the owner primarily follows progress, blockers and integration state. The dashboard must make that change of emphasis visible without introducing another source of orchestration state or interrupting a live investigation.

The existing dashboard is a read-only projection of the authoritative ledger. It already exposes the dependency graph, planned and actual timelines, filters, details and native conversation or pull request links. The experience decision therefore governs presentation, interaction and durable UI preferences while preserving the existing data and link contracts.

## Decision

### Phase-aware presentation

Derive one monotonic `编排展示阶段` from the run data:

- `planning` remains active until a real task has an actual start fact.
- `execution` begins when any real task has started and never reverts.
- A `starting` state or dispatch claim without an actual start fact does not trigger the transition.
- Selecting a plan version does not change the run phase.

Keep the existing graph, planned and actual views rather than adding a user- controlled phase mode. On an initial load, planning opens on the dependency graph and execution opens on actual progress. If a live page crosses the phase boundary, retain the current tab, filters, selection, scroll position and focus; show a non-blocking notice with an entry point to actual progress.

Planning emphasizes the dependency graph, planned timeline, readiness and blockers. Execution emphasizes the actual timeline, running state, blockers and integrated work. Neither phase hides the other phase's authoritative data, and the summary uses existing ledger fields rather than inferred completion or remaining-time metrics.

### Workspace and responsive details

Use a calm developer-workspace treatment: neutral chrome, a restrained framed-sheet surface, clear product identity and data-led status colour. Do not add a marketing hero, generic KPI card grid, or permanent application navigation that competes with the orchestration workspace.

Use the following width contract, measured against the `.workspace` content width `W` rather than the browser's outer width:

| Width | Layout contract |
| - | - |
| **宽桌面双栏**：`W >= 1356px` | A selected open detail uses a `336px` right inspector with a `20px` gap; the graph/main column retains at least `1000px`. |
| **中屏品字型**：`768px <= W < 1356px`, usually `768px-1444px` viewport | The graph/view spans the full first row. The second row places tasks on the left and selected details on the right with asymmetric widths; details do not reduce graph width and disappear when there is no selection. At `768px-1119px`, task cards use two columns and controls may wrap. |
| **窄屏底部抽屉**：Viewport `<768px` | The workspace is one column. Selected details use a bottom drawer capped at `82dvh`; plan and summary surfaces become two-column, and task cards remain horizontally scrollable. |

Closing or clearing the selection removes the detail surface and leaves the main column full width at every band. A fine hovering pointer may show a 250ms preview when no committed detail is open; touch, keyboard and other non-hovering input remain selection-driven. Temporary surfaces support close, `Escape` and backdrop dismissal, and restore the originating focus and scroll position when closed. Selecting another item while a temporary surface is open updates that surface rather than closing it.

The wide detail pane keeps a valid `详情选择` even when a filter hides the object. It clears only when the object is removed or its ID becomes invalid.

Timeline interaction is explicit: ordinary wheel input must not zoom or consume page scrolling; only `Ctrl` + wheel zooms around the pointer. Timeline pan remains available through primary-button drag, and the toolbar buttons remain available for users who do not use wheel gestures.

### Selection, accessibility and motion

Clicking or keyboard-selecting an object commits the detail selection. A fine pointer may show a short, approximately 250ms `详情预览` on graph or timeline objects, but the preview has no actions and never replaces the committed selection. Lists only highlight on hover; touch and keyboard interaction do not depend on hover.

The semantic task and group lists are the complete keyboard and assistive- technology source of truth beside the visual graph. Graph nodes do not create a second node-by-node tab sequence. Temporary detail sheets and drawers move focus into the surface, constrain focus while open, and restore focus on close; the persistent wide pane does not trap focus. Status is conveyed through text and icons, not colour alone, and reduced-motion preferences disable panel, layout and refresh animations.

Task cards and details may show two direct runtime facts already present in the ledger projection: current duration from recorded start/finish timestamps and the latest owner-facing Agent output. Output is projected only from explicit `latest_output`, `assistant_output`, `agent_output`, or assistant-role `message` fields in an event associated with that task. Missing output stays empty; planned output, arbitrary event fields and inferred text are never displayed.

Live refresh preserves the current view context and never auto-scrolls or auto-opens a new object. Keep the last valid snapshot during stale or disconnected states, display connection state and data time, and never replace unknown values with zero. A first-load failure has an explicit error state; reconnection refreshes the projection.

### URL view state

Persist shareable dashboard context in URL query parameters as `URL 视图状态`. The state includes the selected tab, search text, filters, selected plan, selected task or group, detail expansion, graph zoom and timeline window. Defaults are omitted from the canonical URL. Page load and browser back/forward navigation restore valid parameters; unknown or invalid IDs are ignored without blocking the dashboard. URL state contains only stable identifiers and view values, never task data, credentials or service tokens.

URL view state is not written to browser storage, the ledger or the global preference file. Theme is deliberately separate: it is the only current `全局界面偏好`, stored as `ui-preferences.json` under the task-orchestration Skill's global data directory. The preference file includes a schema version and `system`, `light` or `dark` theme value, uses the existing lock and atomic replacement conventions, applies immediately, and falls back to system theme when missing or unreadable.

## Consequences

The dashboard supports both plan review and live execution monitoring without forking the ledger contract or making the owner change modes manually. A shared URL can reproduce the relevant debugging context for another Agent, while global theme preference survives page and Worktree changes without polluting shareable links or orchestration state.

Responsive details require explicit focus restoration and separate wide, medium and narrow interaction tests. The graph remains visually useful while the semantic lists provide a stable accessibility and keyboard contract.

Graph and timeline canvases use the same wheel contract: ordinary wheel input continues page scrolling, while `Ctrl` + wheel is required for viewport zoom. Primary-button drag remains the pan gesture where the underlying view supports it, and explicit zoom controls remain available.

## Rejected Alternatives

- Add a manually switchable planning/execution mode: rejected because the phase is a fact of the run and a second mode can contradict the ledger.
- Force the live page to jump to actual progress at the phase boundary: rejected because it steals the owner's current investigation context.
- Persist all view controls in browser storage or the ledger: rejected because it prevents reliable sharing and mixes UI state with authoritative run data.
- Add a second dashboard state store: rejected because the ledger remains the only orchestration source of truth.
- Make hover, colour, or the graph canvas the only interaction path: rejected because touch, keyboard and assistive-technology workflows need equivalent semantic controls.
