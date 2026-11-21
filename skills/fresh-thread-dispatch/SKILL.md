---
name: fresh-thread-dispatch
description: "Create a clean, user-owned Codex task when the owner explicitly delegates work to a new Codex thread/task; distinguish fresh dispatch from thread moves and forks."
---

# Fresh Thread Dispatch

Use this Skill only for an explicit request to move work into a **new** Codex task, such as "移交给新的 Codex thread/task" or "在新 worktree 继续". It creates the task and hands over the bounded assignment; the cutover applies to that assignment, not to unrelated work retained by the parent. It is not a delivery flow or a tracking loop.

## Defaults

- Create one fresh, user-owned task through the native `create_thread` tool.
- Unless the caller supplies a flow-owned profile, use `gpt-5.6-luna` with `max` thinking for a generic fresh task. A flow-owned locked profile takes precedence over this generic default.
- For a flow-owned task, copy the envelope's `locked_profile` and pass its exact `model` and `thinking` values to native `create_thread.model` and `create_thread.thinking`. The caller-owned profile policy takes precedence over the generic fresh-task default; do not reselect or substitute a flow-owned profile. Do not reselect by task description, normalize a thinking value, consult a runtime capability table, or substitute a fallback.
- A complete owner override contains both `model` and `thinking`; it may bypass the caller's autonomous allowlist and must be forwarded unchanged. Record the override source and scope in the task envelope. An invocation-wide override must be materialized in every nonterminal task lock, including future-wave tasks; terminal skipped or completed history remains immutable. A model-only or thinking-only instruction is incomplete and must not be filled in by the dispatch skill.
- Always pass the resolved model and thinking pair to `create_thread`. A current task's explicit directive may authorize that creation call, but the fresh task does not inherit the parent session's override state; carry an owner directive in the child prompt when the child itself must authorize a non-autonomous launch.
- To authorize a non-autonomous model for this task, the owner must place the exact standalone `agent-model: <model>` directive on the first non-empty prompt line; natural-language mentions and quoted examples do not authorize an exception.
- The directive must use the canonical model identifier exposed by the current tool; family shorthands are not authorization for an exception.
- Preserve the owner's delivery intent in the child prompt. A requested `$fast-flow`, diagnosis Skill, or exact stop condition belongs to the child; dispatch itself does not grant extra GitHub, merge, or deployment authority.
- A fresh dispatch is an assignment-scoped, one-way, one-time transfer. It transfers only the explicitly bounded assignment; it does not transfer or freeze unrelated work retained by the parent. Once `create_thread` succeeds, the parent must not continue the transferred assignment, perform child work, or automatically wait, supervise, coordinate, or relay. Read the [handoff envelope](references/handoff-envelope.md) for the fact-selection and relay boundary.
- Creation outcome handling — pending `clientThreadId`, unknown outcomes, adapter failure receipts, and request-identity binding — is owned by `references/dispatch-outcome.md`.
- A runtime rejection after a profile was forwarded is a runtime fact, not a flow-level capability result. Report it as-is. A retry or recovery of an existing task reuses its locked pair; it may change only after an explicit owner replacement is recorded in the envelope.
- If an explicit relay has an ambiguous or contradictory target or content, clarify before relaying; do not infer a target, message, or authority.
- The dispatch operation stops after the task is created. A later parent message that clearly concerns unrelated or explicitly retained parent work remains parent-scoped and may be handled in the parent without child operations only when its files, branch, checkout, and other mutable resources are disjoint from the transferred assignment. For an explicit `local` dispatch, the parent and child share the saved checkout; if that disjointness cannot be proven, clarify or use an isolated worktree before mutating either assignment. Scope follows the owner's explicit target, not keyword overlap: even a message mentioning the transferred artifact remains parent-scoped when the owner says to continue the current/parent conversation and not affect the new task. A clearly child-scoped continuation is not performed in the parent; if its target or requested relay is unclear, clarify first.

## Multi-task-flow-owned creation

For a delivery-unit/task owned by an active multi-task-flow ledger, use that flow’s `conversation-create` CLI after its dispatch claim instead of this Skill’s generic native tool recipe. Preserve the ledger’s complete `model + thinking` pair verbatim. The flow owns capability validation, native request binding, creation evidence, freeze and unknown reconciliation. Never substitute a generic default or change the conversation profile after creation. Generic owner-requested fresh conversations continue through the native tool steps below.

## Resolve The Target

1. Confirm that the owner explicitly asked for a fresh task. Resolve the target project through `list_projects`; ask one question only when the project or target work is genuinely ambiguous.
2. Select the requested execution environment. "New worktree", including "new local worktree", means `environment.type=worktree`; "local", "saved project", or "current checkout" means `environment.type=local`. If unstated, use `worktree` for a Git project and `local` otherwise. The required native `environment` field is populated from this resolved default; it does not require a separate owner decision. If the requested environment is unavailable, incompatible with the project, or conflicts with another instruction, explain the constraint and ask for one explicit resolution before creation. Never substitute an unavailable or conflicting environment silently.
3. Keep the default worktree baseline by omitting `startingState`. Use `working-tree` only when the owner explicitly asks to carry the current uncommitted state; use a branch starting state only for an owner-named ref. Never create a manual Git worktree.
4. Compose the child prompt from the minimum handoff facts. Read [the handoff envelope](references/handoff-envelope.md) before creating the task.
5. Call `create_thread` with the resolved project, environment, profile, and handoff prompt. Use the current tool schema rather than copying API fields from this document. This Skill cannot change the native tool's contract or higher-priority instructions.

## Resolve The Title

Resolve the task title before composing the handoff prompt and before calling native `create_thread`.

- If the owner supplied a title, use it with only whitespace normalization. Do not silently truncate it; a title longer than 32 Unicode code points must be rejected and the owner must shorten it.
- Otherwise derive the title only from the transferred task intent and its primary outcome. Use the concise `action + subject + decision boundary` form, target no more than 24 Unicode code points, and remove protocol labels, acceptance details, Skill references, URLs, paths, and execution context.
- For a multi-step Goal, title the final or primary outcome rather than the investigation sequence. If no meaningful title can be derived, use `移交任务`.
- Do not derive a title from the complete handoff prompt, `Verified context`, `Scope and constraints`, or `Execution and stop condition`. The full five-section prompt remains complete and structured for the child.
- Always pass the resolved title as native `create_thread.title`; never omit it and let the platform summarize the handoff prompt.

## Native Request Shape

Before the call, materialize the resolved profile into the request. A generic fresh task uses `model=gpt-5.6-luna` and `thinking=max`; a flow-owned lock or a complete owner override replaces that pair verbatim. A model-only or thinking-only value is invalid.

For a project task, the native request contains only the task-creation fields:

```json
{
  "prompt": "<handoff prompt>",
  "target": {
    "type": "project",
    "projectId": "<resolved project id>",
    "environment": { "type": "worktree" }
  },
  "model": "gpt-5.6-luna",
  "thinking": "max",
  "title": "<resolved task title>"
}
```

The resolved title is task metadata, not a dispatch identity or ledger field.

Use `environment.type=local` for an explicit local request. Add `environment.startingState` only when the owner explicitly requests the current working tree or an owner-named branch. Keep `task_id`, `dispatch_operation_id`, request bindings, and receipt fields in the local task envelope; never append them to native `create_thread` arguments.

## Routing Boundary

- Use `fork_thread` only when the owner asks to retain completed conversation history. A fresh dispatch intentionally starts with compact context.
- Use `handoff_thread` only to relocate another existing Codex task and its Git state. It cannot replace a fresh task dispatch from the current task.
- A fresh dispatch creates one explicitly bounded task only. Multi-task scheduling, dependency coordination, and PR integration are outside this Skill; it does not infer a coordinator from the assignment or poll, supervise, or merge other work. Independent work across different projects may receive one fresh task per explicitly named project.

## Completion

After a successful call, state the created task's title and resolved environment, then emit the required `::created-thread` directive using the returned `threadId`, or using `clientThreadId` only as the platform's setup-pending creation acknowledgement. The latter is not an owner-navigable task link and is not a target for observation/read, navigation, or relay. Do not navigate to the task, perform child work, poll for readiness, or duplicate its follow-up message in the parent. End the dispatch operation there; continue any separate parent-scoped work only under its own instructions, and do not re-enter the transferred assignment automatically.
