# Fresh Thread Dispatch History

## Lifecycle / Compatibility

- Fresh dispatch is introduced as the focused path for an explicit request to create a new Codex task. It does not replace `fork_thread`, `handoff_thread`, or `$wave-thread-flow`.

## Replacements / Background

- The owner repeatedly requested new Codex tasks with a specified profile and worktree intent. The durable contract makes those repeated decisions explicit while keeping parent-task orchestration out of the child prompt.
- Dispatch cutover is assignment-scoped: creating a child task stops parent handling of the transferred assignment and automatic child coordination, but it does not freeze resource-disjoint work retained by the parent. Shared local checkouts require disjointness proof or an isolated worktree before mutation; pending `clientThreadId` setup remains platform-owned and is never retried or rebound by the parent. Failed or contradictory creation results are unknown and require owner/platform reconciliation before any retry or overlapping continuation.
- An unstated environment now resolves to `worktree` for Git projects and `local` otherwise. The native creation field is populated from that default; it is not a reason to ask the owner to repeat the choice.

## Related Changes

- None.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
