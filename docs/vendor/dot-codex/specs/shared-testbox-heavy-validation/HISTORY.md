# Shared host history — superseded

## Lifecycle / Compatibility

Superseded by [Agent VM](../agent-vm/SPEC.md); no current operating entrypoint or fallback remains. [ADR 0025](../../adr/0025-native-incus-agent-vm-lifecycle.md) supersedes [ADR 0015](../../adr/0015-agent-owned-shared-testbox-workspace.md).

## Historical Facts

The former shared host model replaced a centralized dispatcher with Agent-owned persistent directories identified by `CODEX_THREAD_ID`. Git standard selection and rsync populated a source mirror, while ordinary Docker/Compose and native file transfer were chosen by the Agent. Runtime/tool/domain cache paths were shared by convention. Explicit targeted cleanup protected other Agent directories, and global Docker pruning was prohibited.

These are historical facts, not current instructions. Original requirements, helper sources and validation records are recoverable from Git history. The successor uses isolated guests and disposable stopped-disk caches rather than shared host workspaces or cache directories.
