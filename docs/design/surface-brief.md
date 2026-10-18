# Loomhelm master design surface

## Scope and Mode

The complete UI design remains one task. Its structural master is `design/index.html`, using Operate mode inside a Read-mode review document. `design/styles.html` is a separate visual style sheet for choosing a UI language before applying it to that prototype. Supporting context and metadata remain under `docs/design/` and are not served with the prototype.

## Confirmed Direction

The owner has confirmed an efficient global workbench, attention-first hierarchy, in-place approval review, complete mobile capability parity and a task workspace combining one main session with task information. Native supporting sub-agent work is expandable within the main session. The owner's engineering flows remain external context.

The owner has accepted the navigation hierarchy and its desktop/mobile structural screenshots. The accepted structural prototype uses neutral styling; that acceptance does not select a product visual world or approve the complete design. The owner requires independent UI style choices before applying any visual treatment to the prototype. The workbench variants in the master were rejected as insufficiently distinct from the structural prototype; their pending choice is withdrawn. No direction is selected.

The theme follows the operating system by default and supports manual light/dark selection and returning to the system setting. Desktop and mobile remember that preference independently. Both themes must preserve the same information hierarchy, controls and readable state distinctions.

## UI Style Selection

The style sheet compares the same typography specimen, tabs, two list rows, status labels, input and primary/secondary/disabled buttons in four visual languages. It contains no product navigation, workspace arrangement or business workflow. The prototype file remains unchanged during this selection. Each style can be enlarged independently; choosing a style is discussed with the owner and does not silently apply a theme.

| Style | Visual language | Tradeoff |
| - | - | - |
| A: Minimal / Flat | Precise text alignment, fine rules, small corners and flat controls | Efficient and restrained, with less distinctive personality |
| B: Soft / Tactile | Soft neutral layers, rounded controls, recessed inputs and raised buttons | Approachable depth; dense screens need restraint in elevation |
| C: Neo-brutalist | Strong type, square controls, visible outlines, solid fills and hard shadows | Distinct boundaries; greater visual presence during sustained work |
| D: Glass / Layered | Translucent panels, frosted separation, fine highlights and light-weight type | Strong material character; reading areas need sufficient opacity |

These are UI style options, not four product layouts or an approved design system. Product content, complete light/dark variants, responsive workspaces and all business states will be designed after the owner chooses or revises the visual language. The existing system/manual theme decision remains unchanged.

Local style lookup uses the minimalism-and-swiss-style, neumorphism, neubrutalism and glassmorphism entries in ui-ux-pro-max. Those entries supply style vocabulary, not product facts or an automatic recommendation. This is a component-language comparison rather than a selected visual-world build, so no new global DESIGN.md or direction contract is claimed.

Browser checks cover identical specimen content, sampled text contrast, tab selection, button feedback, enlarged-style routing and horizontal overflow at 393, 1024 and 1440 CSS pixels. Mobile action buttons are at least 44 CSS pixels high. The detector reports no findings. These checks concern the standalone sheet only; they do not validate a complete UI, product themes or backend behavior. Candidate screenshots remain temporary until owner review.

Visual evidence status: Storybook覆盖=不适用; 视觉证据目标源=ui_demo; 视觉证据=存在; 空白裁剪=已裁剪（desktop）/无需裁剪（mobile）; 聊天回图=已展示; 证据落盘=未落盘（canonical assets await owner review）; 视觉比较=需确认. The standalone sheet is login-free and uses synthetic content. Desktop and mobile captures are temporary; accepted structural navigation assets remain authoritative for structure only. The exact destination paths have no baseline at locked base a506804ae42da75749d62aac901c8864cd1de96c, so both candidates are current-only and have no two-sided report or heatmap.

## Tool Context

The default root invocation cannot resolve the scoped PRODUCT.md. Running `concept-seed --scope direction --mode operate` from `docs/design/` succeeded, with seed `f8d1abaf` and assigned grounded candidate 4, an incident-response workbench. Reproducing the same seed retained that assignment for proposal A; it does not override the owner's sequence or constitute a choice. No root PRODUCT.md, DESIGN.md or .impeccable is created.

## Rejected Prototype Treatments

The owner rejected the workbench treatments below because they modified the prototype instead of providing independent UI style choices. They remain in the unchanged prototype file as unapproved background, not the active selection. The current choice is the standalone style sheet above. No direction is selected and no finished design system or complete UI is approved.

The grounded list, ordered by resonance, is an engineering work journal, a code-review split view, a laboratory observation log, an incident-response console, a newsroom assignment ledger, a rail dispatch register and a source-control relationship map. This spans screen conventions, physical records and spatial notation. The reproduced `f8d1abaf` hand retains assigned candidate 4; B represents the top grounded candidate. These exploratory studies use directly rendered HTML, not approved image comps or a selected production build. The owner's single master-entry constraint replaces the skill's separate decision server; no second design artifact or port is introduced.

| Proposal | Visual world and first workspace | Main tradeoff |
| - | - | - |
| A: Duty desk / 值守台 | Slate navigation, cool neutral work surface, amber attention states, compact separated queue/context/recent columns; work is triaged in place | Strong partitioning helps scan and act, while longer explanations use more vertical space |
| B: Work journal / 工作日志 | Pale blue navigation, near-white ground, indigo actions, wider type rhythm and ruled attention rows; requests and recent conversation records read continuously | Recommended for sustained reading, with lower density and a more familiar visual character |
| C: Standard tool workspace / 标准工具台 | Neutral navigation, restrained violet actions, conventional two-column queue/context and recent conversations | Familiar controls and density, with less distinctive identity |

All six catalog challengers were weighed on audience identification and product clarity. They remain available for owner steering; none is adopted silently. The variable-font specimen loses the operator's familiar task grammar and useful information density; its contribution is decisive type hierarchy. Crouwel's construction grid loses familiarity and makes an irrelevant mechanism prominent; it contributes alignment discipline. Metro tiles lose rapid task comparison and full-request clarity; they contribute unmistakable selection. Orienteering loses the default approval scene and direct request reading; it contributes consistent relationship/state notation for the later graph. Zoo-map lobes lose compact operator conventions and clear request reading; they contribute unambiguous region boundaries. Ticket-wallet coupons lose parallel-work familiarity and imply an unconfirmed sequential journey; they contribute traceable requests, decisions and outcomes. These are declined on both axes, presented as compact exploration notes rather than equal visual promises. A carries the resulting hierarchy, alignment, selection, notation, boundary and traceability standards without borrowing their motifs.

The pending choice among these prototype treatments is withdrawn. The owner selects, revises, combines or rejects a visual language using the independent style sheet. Detailed desktop/mobile/light-dark/state refinement and the final direction contract follow that choice. Navigation and business rules are not being re-interviewed.

The controlled page checks cover all three workbench directions at desktop 1440×900 and mobile 393×852, plus desktop dark previews. They check fixture parity, complete approval context, horizontal overflow, mobile navigation, demo request selection/denial, sampled text contrast and the master entry's direction/theme/device/notes/neutral-prototype controls. C's excess queue-to-request gap and B's muted-navigation contrast were corrected. The detector reported no findings. These are limited direction-study checks; they do not validate the complete design, other page themes, product preference persistence, real backend operations or cross-project graph behavior. The three desktop comparison images remain temporary until owner review; no unselected direction images replace accepted navigation assets.

## Structural Contract

The top-level global navigation is Workbench and Tasks. The workbench prioritizes a short attention queue with an adjacent or following request review and compact conversation access; its All Conversations action opens the cross-project conversation list and creation path. Global Tasks spans all projects and supports list/board/graph switching. Opening a task keeps its conversation, sub-agent activity, shared draft and task state in the same workspace. Mobile reorganizes conversation and task information into task-local panels with the same capabilities.

Below the global navigation, the Conversations group directly lists projectless conversations, replacing the former Unassigned Project label. No separate global Conversations button remains in navigation. The collapsible Projects tree contains named projects with conversation leaves directly underneath. Both task-associated conversations and project conversations without tasks are included, with task association readable as metadata. Desktop and mobile expose the same hierarchy. Clicking a project switches its context; the prototype offers task and conversation panels, and the latter includes all that project's conversations. The active leaf/context and breadcrumb track the displayed scope.

Project tasks support list, board and graph views. The prototype stores the chosen task view independently for global Tasks and each project in client-local prototype storage; the default is list. Navigation expansion and the project-content panel are client browsing state; the prototype does not synchronize them across devices.

All Conversations includes task-associated and standalone conversations. New conversations can start without a task or project; project selection is optional. Task and conversation bindings are one-to-one and remain fixed in phase one. The prototype offers unoccupied tasks and a new-task path, preserving the same conversation, history, private draft and reading position. A creator-private projectless conversation joins the chosen task's project only after an explicit history-sharing confirmation; the draft remains private to the creator's own devices. Existing project conversations can bind only within that project. There are no replacement, detachment or cross-project migration actions.

Task business states are To do, In progress, Blocked, Done and Cancelled. Run completion does not automatically complete a task. The prototype's list, five-column board, graph, filters and task workspace use this same vocabulary. Concurrent drafts and reconnect conflicts automatically adopt the last modification; sending consumes only sent content and retains newer input, and recovery never sends. Real cross-client ordering, deduplication, privacy enforcement and recovery remain public-contract and backend verification work, not capabilities proved by the single-client mock.

The graph distinguishes task containment from prerequisite-to-dependent task edges. Both may cross projects; neither relationship changes a task's own project, main session or execution ownership. Project containment and task parentage are separate relationships, so a cross-project child must not appear to belong to its parent's project. In a project view, authorized external endpoints carry their actual project; unauthorized task contents must not be exposed through related nodes, previews or labels. The current structural prototype uses same-project mock containment with solid lines and directed dashed dependency edges, supports scrolling, zoom and opening the same task nodes, and does not yet demonstrate cross-project endpoints. Cross-project fixtures and presentation must be included when the graph receives the selected visual direction. Real relationship contracts and authorization remain implementation handoff dependencies; the prototype does not implement relationship editing.

The owner has ruled out a user-facing host concept and has no current multi-host connection plan. Host navigation, selectors and sample machine names are removed. The integrated contract uses one preconfigured logical execution environment, keeps Server/Worker/Connector separate and treats Connector administration as deployment-internal. The execution machine may be separate from the platform; existing desktop-session control still needs actual capability evidence.

Files stay in their conversation context. The owner has rejected a standalone artifacts module, including a global page and task-specific panel. A remote file browser is only a possible future capability, outside the current design scope.

All content is labeled demonstration data. Approval, input, conversation creation, history-sharing confirmation and task-association interactions update only prototype state. Real cross-client draft synchronization, authorization, Codex execution, original-file downloads and PWA installation are not implemented or accepted by this artifact. Scenario controls demonstrate intended state presentation only. Confirmed product rules come from the main coordinator's PRD; remaining relationship-scope, deletion and team-permission choices are not inferred here.

## Open Decisions and Dependencies

The owner still needs to choose final visual direction, review detailed page layouts and confirm the complete design. The main coordinator owns the remaining PRD business-rule interview; this design task consumes those answers without repeating the questions. F02, R02, F05 and RD03/G0 actual inputs must supply the framework, real fixtures, public interfaces and recovery/deployment contracts before final U01–U04 page/component/state/API handoff.

## Visual Evidence

The owner accepted this structural navigation set: Workbench and Tasks at the top, projectless conversation leaves under Conversations, and Projects → named project → conversation leaves. This is approval of the displayed navigation and screenshots, not final visual design or real backend behavior. The source is the login-free, mock-only `design/index.html?canvas=1`; viewport emulation uses desktop 1440×900 and mobile 393×852 CSS pixels. Trim-only normalization left both captures unchanged. These images document the accepted navigation structure; subsequent interaction states are reviewed separately.

![Accepted desktop navigation](../../design/evidence/project-tree-desktop.png)

![Accepted mobile navigation](../../design/evidence/project-tree-mobile.png)
