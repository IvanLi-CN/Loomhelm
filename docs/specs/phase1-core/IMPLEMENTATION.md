# Loomhelm core implementation coverage

## Current Status

The repository has an initial Git baseline and engineering conventions. No runnable product, public interface, Connector, migration or deployed environment is implemented yet.

## Implementation Coverage

| Requirements | Implementation | Verification |
| - | - | - |
| REQ-LH-001 through REQ-LH-012 | Product implementation absent | Product verification not run |

## Development and Validation

The baseline is checked with the topic Spec structural checker, Git whitespace checks and inspection of Policy package/lock consistency. Runtime and product commands will be documented when their actual implementations exist; no placeholder check reports success on their behalf.

## Rollout and Compatibility

No database schema or runtime state format is deployed. Candidate identity, migration evidence and supported compatibility windows must be recorded with their actual implementations. The release channel used for initial acceptance is an isolated parent-branch preview; production configuration is not established here.

## Remaining Gaps

All product requirements still require implementation and the observations described by their VER entries. In particular, existing active desktop-session control has not been proven, and the complete product UI awaits owner participation and confirmation.

The approved product boundaries require a single configured execution environment, global Workbench/Tasks/Conversations navigation, conversation-context files, shared drafts and task relationships. Their presence in the specification is not evidence of backend support. Structural prototype checks do not establish real Codex, persistence, cross-client synchronization or PWA acceptance.

The complete [product requirements](../../PRD.md) await explicit owner confirmation. Its business suggestions are not approved defaults. Business implementation and public business contract finalization wait for that confirmation and resolution of the affected decisions; product UI additionally waits for complete design approval. Skeleton, infrastructure, capability research and the existing design discussion remain permitted.

Standalone creation with optional project selection and later task association is established product intent, including actual execution before a task exists. The task-mandatory Run definition has been corrected; existing adapter capability and authorization support are not thereby proven. Projectless conversation ownership, historical visibility on association, reverse task/session cardinality and reassignment semantics require decisions before implementation. The public task-relationship contract must settle state enumeration, cross-project rules, cycle handling, editing and removal. Shared-draft concurrent editing, send consumption and disconnection recovery, and the small-team permission matrix remain unresolved. These decisions are collected in the PRD rather than treated as settled engineering behavior.

Client-local, identity/workspace-scoped view preferences are the implementation default; they do not introduce a server preference service or move another client's active view.

## References

- [Requirements](SPEC.md)
- [History](HISTORY.md)
