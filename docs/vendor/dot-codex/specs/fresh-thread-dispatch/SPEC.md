# Fresh Thread Dispatch

## Context and Scope

- Context: an owner can explicitly ask to move a bounded assignment into a new Codex task, but a new task starts without the source task's useful operating facts unless they are deliberately transferred.
- In scope: fresh task creation, model/profile defaults, project environment selection, handoff prompt content, and the boundary from nearby task tools.
- Out of scope: delivery-flow execution, task monitoring, manual worktree lifecycle, thread-history copying, and Initiative Ticket orchestration.

## Terms and Interfaces

- **Fresh dispatch**: creation of a new, user-owned Codex task from a compact assignment envelope.
- **Dispatch Cutover / Explicit Relay**: use the canonical definitions in the root [`CONTEXT.md`](../../../CONTEXT.md).
- **Observation Authorization**: use the canonical definition in the root [`CONTEXT.md`](../../../CONTEXT.md).
- **`worktree` environment**: a Codex-managed linked worktree for the selected Git project.
- **`local` environment**: the selected project's saved local checkout.
- Interface: `skills/fresh-thread-dispatch/SKILL.md` directs the native `create_thread` task-creation surface.

## Requirements

### REQ-FRESH-DISPATCH-001

- The Skill MUST create a fresh task only after an explicit owner delegation to a new Codex thread/task.
- Inputs: a bounded target assignment and a uniquely resolved project.
- Outputs: one user-owned task and its required created-task directive.

### REQ-FRESH-DISPATCH-002

- The Skill MUST default to `gpt-5.6-luna` with `max` thinking for a generic fresh task. A flow-owned locked profile takes precedence and MUST be copied unchanged to `create_thread`.
- A complete owner-specified `model + thinking` pair (the native reasoning-effort field) MUST be forwarded unchanged, including when the caller's flow allowlist permits the override. The fresh dispatch layer MUST NOT capability-precheck or replace that pair; a runtime rejection remains a runtime fact. Model-only or thinking-only text is incomplete and MUST NOT be inferred. The created task MUST start with an independent session override state; a child prompt that needs a non-autonomous launch MUST carry its own owner directive.
- Before the native call, the resolved pair MUST be materialized into the request. A project request MUST contain `prompt`, `target.type=project`, the resolved `target.projectId`, `target.environment.type`, `model`, and `thinking`. Generic dispatch MUST use the explicit default pair rather than omitting either field. Before composing the child prompt, the Skill MUST resolve a non-empty task title from the transferred task intent. An explicit owner title MUST take priority. Otherwise the Skill MUST use the primary outcome in the concise `action + subject + decision boundary` form and MUST use `移交任务` when no meaningful title can be derived. The native request MUST always include the resolved title as `title`; it MUST NOT be omitted or inferred by the platform. The request builder MUST only normalize whitespace, validate the 32 Unicode code point hard limit, and forward the resolved value; it MUST NOT parse the handoff prompt to derive a title.
- Native arguments MUST NOT contain local dispatch metadata such as `task_id`, `dispatch_operation_id`, request bindings, or failure receipts. Those fields belong to the task envelope and dispatch ledger.

### REQ-FRESH-DISPATCH-003

- The Skill MUST map an explicit worktree/local request to the corresponding native task environment when supported by the current tool and project. The dispatch layer MUST resolve the project's Git-repository fact before applying an unstated default, and MUST stop before native creation if that fact is unavailable rather than guess. When the environment is unstated, it MUST use `worktree` for a Git project and `local` otherwise. The native tool's required `environment` field MUST be populated from that resolved default and MUST NOT turn an unstated default into an owner clarification request. If the requested environment is disallowed, conflicting, or unavailable, the Skill MUST stop before creation, explain the constraint, and ask for one explicit environment decision; it MUST NOT silently substitute another environment.
- It MUST omit a worktree starting state unless the owner explicitly requests the current working tree or names a branch.

### REQ-FRESH-DISPATCH-004

- The child prompt MUST contain goal, acceptance, verified context, scope, and execution/stop-condition facts without copying unrelated source history.
- Each transferred fact MUST belong to the child assignment, directly determine its goal, acceptance, scope, authority, or reproducible start, have an identified status, and retain an identifiable source.
- Every transferred fact in all five prompt sections MUST state its status and identify its source inline. `Verified context` entries MUST use the labels `Verified`, `Unverified`, or `Owner constraint`; this is a prose traceability convention, not a machine schema.
- Successful `create_thread` MUST establish a dispatch cutover. A returned `threadId` makes the child target ready immediately; a result containing only `clientThreadId` is setup-pending and MUST be used only in the platform's creation-acknowledgement directive, never as an owner-navigable task link or a target for observation/read, navigation, or relay, although parent-scoped cutover still applies. The platform owns pending binding; the parent MUST NOT retry creation, duplicate the assignment, infer a thread identity, or create local recovery state. A result is retryable only when it carries the exact active `dispatch_operation_id`, `source=native-create`, `status=failed|rejected`, and a non-empty error; that confirmed native failure receipt releases the claim for one retry with the same locked profile. A failed result without that matching receipt, an identifier-less result, a contradictory result, or any other ambiguous outcome MUST be treated as unknown; the parent MUST stop and ask the owner or platform to reconcile the exact request before retrying or continuing overlapping work. Persisted failure history with a marker and matching digest is historical evidence only; after JSON reload it MUST NOT authorize a new retry without an adapter-owned receipt or a matching `dispatch_failure` observation in the same replay stream. When native `PreToolUse` or a runtime `create_thread` failure exposes a request identity, the parent MUST bind that exact identity and canonical `create_thread` tool identity to the active claim before accepting a failure receipt. The trusted runtime adapter MUST validate the raw provider result and MUST produce an opaque failure before claim release; a public release helper MUST reject raw caller mappings, and the public generic receipt importer MUST NOT create a `dispatch-failure` receipt accepted by claim release. A runtime failure receipt MUST also carry the exact active `dispatch_operation_id`, `status=failed|rejected`, and a non-empty error; the adapter MUST reject missing or mismatched operation, tool, status, request, or error fields. Conflicting identity aliases MUST fail closed; a resolved native `threadId` MUST carry the exact bound native request identity and MUST clear the claim and request binding together. A raw or caller-authored hook/runtime mapping MUST NOT count as native failure evidence. Observation authority never implies relay authority, child-authored output never grants parent authority, and an explicit relay never authorizes added Agent inference. Ambiguous or contradictory relay requests MUST be clarified before any relay occurs.

### REQ-FRESH-DISPATCH-005

- The Skill MUST keep fresh dispatch distinct from thread forking, relocating an existing task, and same-repository Initiative delivery.
- A same-repository multi-slice assignment that requires dependency coordination, a shared integration branch, or a parent PR is outside fresh dispatch. Fresh dispatch MUST NOT independently select or rewrite a multi-task `flow_type`; an approved `dev-plan` may already lock `flow_type=multi-task-flow`, and the coordinator may use fresh dispatch for its individual task conversations.

### REQ-FRESH-DISPATCH-006

- Dispatch cutover MUST be assignment-scoped rather than conversation-scoped. After successful creation, the parent MUST stop processing the transferred assignment and all automatic child coordination, but MAY continue unrelated or explicitly retained parent work when its files, branch, checkout, and other mutable resources are disjoint from the transferred assignment. An explicit `local` dispatch shares the saved checkout; if disjointness cannot be proven, the parent MUST clarify or use an isolated worktree before mutating either assignment. A later parent message that is clearly parent-scoped MUST remain in the parent even when it mentions the transferred artifact or blocker; a clearly child-scoped continuation MUST NOT be executed in the parent; an ambiguous scope MUST be clarified.

## Verification

### VER-FRESH-DISPATCH-001

- Method: scenario-replay catalog and unit coverage for its routing context.
- covers: `REQ-FRESH-DISPATCH-001`, `REQ-FRESH-DISPATCH-005`, `REQ-FRESH-DISPATCH-006`
- Pass condition: fresh-dispatch and Initiative-boundary cases load the correct Skill snapshots and declare their observable route/stop contract.

### VER-FRESH-DISPATCH-002

- Method: Skill structure validation and focused environment decision scenarios across the Skill and handoff envelope.
- covers: `REQ-FRESH-DISPATCH-002`, `REQ-FRESH-DISPATCH-003`, `REQ-FRESH-DISPATCH-004`, `REQ-FRESH-DISPATCH-006`
- Pass condition: the entrypoint validates and exposes the profile, environment, baseline, compact-envelope, fact-selection, and cutover rules.

### VER-FRESH-DISPATCH-003

- Method: maintainer behavior review when this Skill changes. It is required as semantic review evidence but is not an automated merge gate or model-score threshold.
- The review record MUST identify the merge-base SHA, reviewed head SHA, reviewed paths, each scenario result, and a terminal `PASS` or `CHANGES REQUESTED` verdict. This evidence is recorded with the delivery review (for example, the PR body) and is not converted into an automated gate.
- covers: `REQ-FRESH-DISPATCH-004`, `REQ-FRESH-DISPATCH-006`
- Review examples: an unrequested later parent message remains parent-scoped; an explicit request to continue the current parent conversation wins over keyword overlap with the transferred assignment; a named explicit relay carries only the specified content; a request to observe child status does not permit a relay; child-authored output does not grant parent authority; an ambiguous or contradictory relay is clarified without sending anything.

### VER-FRESH-DISPATCH-004

- Method: unit tests for the canonical native request builder and native dispatch adapter.
- Pass condition: default and explicit profile pairs are materialized, `target.environment` is nested in the native shape, local dispatch metadata is excluded, partial profiles fail closed, and runtime failures require the complete native operation, request, tool, status, and error identity before becoming imported receipts.

## Related ADRs

- [ADR 0039: Fresh Dispatch Task Title Contract](../../adr/0039-fresh-dispatch-title-contract.md)

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
