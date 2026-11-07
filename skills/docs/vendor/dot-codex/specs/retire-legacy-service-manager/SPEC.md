# Retire zellij service manager

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## Context and Scope

This topic defines the repository boundary for retiring the obsolete `zellij-service-manager` workflow and its repository-owned helper chain. It covers the retired skill, `devctl` helpers, launchd templates, active consumer references, and the related catalog entry. Host launchd jobs, logs, state, and other runtime residue remain outside this repository contract.

## Requirements

### REQ-ZELLIJ-RETIRE-001

The repository MUST NOT retain the `zellij-service-manager` skill or the `devctl` and launchd helper files that existed only to support that workflow.

### REQ-ZELLIJ-RETIRE-002

Current skills and topic specifications MUST describe Codex native background terminals and live task ownership for long-running work. They MUST NOT present the retired service manager or its helpers as an active capability, fallback, or required dependency.

### REQ-ZELLIJ-RETIRE-003

The topic catalog and direct consumer documentation MUST remain consistent with the retired repository surface. Unrelated Storybook, port governance, and other shared workflow requirements MUST remain intact. Runtime residue outside the repository MUST NOT be removed by this topic.

## Verification

### VER-ZELLIJ-RETIRE-001 covers: REQ-ZELLIJ-RETIRE-001

- Method: inspect the tracked file set and the deletion diff for the retired skill, `devctl` helpers, and launchd templates.
- Pass condition: no retired repository-owned capability or helper remains in the source tree.

### VER-ZELLIJ-RETIRE-002 covers: REQ-ZELLIJ-RETIRE-002

- Method: search tracked current skills and specifications for active `zellij-service-manager`, `devctl`, or `devctl-gc` references and inspect the long-task wording in the direct consumers.
- Pass condition: current consumers use Codex native background terminals and live task ownership; any retained old-name hit is limited to the retirement specification or necessary historical evidence.

### VER-ZELLIJ-RETIRE-003 covers: REQ-ZELLIJ-RETIRE-003

- Method: validate the catalog entry, the shared Storybook and port-governance requirements, and the documented runtime boundary.
- Pass condition: the catalog matches the repository surface, unrelated shared requirements remain present, and host runtime residue is explicitly out of scope.

## Related ADRs

None

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
- `docs/specs/global-port-preview-governance/SPEC.md`
