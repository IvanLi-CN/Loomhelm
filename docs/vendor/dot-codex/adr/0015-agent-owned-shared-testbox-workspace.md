---
status: superseded
superseded_by: 0025-native-incus-agent-vm-lifecycle.md
---

# Agent-owned Shared Testbox Workspace

Historical decision, superseded by [ADR 0025](0025-native-incus-agent-vm-lifecycle.md). It supplies no current operating entrypoint; use the [Agent VM contract](../specs/agent-vm/SPEC.md).

The shared testbox was a common Linux execution host, so the Agent owned its workload directory and invoke SSH, Docker, and Compose directly. The repository used `/srv/codex/agents/<CODEX_THREAD_ID>/` as the persistent Agent Directory, kept reusable cache paths under the documented runtime/tool/domain convention, and exposed only small helpers for directory creation, Git worktree synchronization, read-only status, and explicit cleanup.

The former centralized dispatcher and automatic reclaimer are retired because their run/control lifecycle, command forwarding, cache policy, and container restrictions made the helper responsible for workload governance. The consequence is that Agents own container lifecycle, cache use, and ordinary file transfer; cleanup is explicit and scoped to the current Agent Directory.
