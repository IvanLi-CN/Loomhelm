# Code Hosting Platform Boundary

> This topic defines the durable control-plane contract used by delivery workflows that target GitHub or the supported self-hosted Gitea instance.

## Context and Scope

- Context: Normal delivery workflows currently expose GitHub-specific commands, URLs, and facts at their call sites, which prevents the same safety contracts from operating against Gitea.
- In scope: Repository binding, provider selection, normalized control-plane facts, guarded PR operations, CI evidence, repository assets, compatibility, and the explicit Initiative boundary.
- Out of scope: Git fetch/push/worktrees, platform administration, credential creation, unsupported hosts, and Gitea support for Initiative Contract v5.

## Terms and Interfaces

- **Repository Binding**: The verified selected remote, platform, host, owner, repository, and canonical web/API origins used for one control-plane operation.
- **Platform Capability**: A named operation with a normalized result and an explicit `unsupported_capability` outcome; missing provider data never becomes a pass.
- **Exact-SHA CI Evidence**: A terminal status or workflow result explicitly associated with the candidate or merge commit SHA.
- **CI Facts Envelope**: The provider-neutral CI observation object containing `policy_state`, `checks_expected`, `ci_evidence`, `gate_effect`, exact-SHA statuses/checks/runs, and typed observation errors. These fields describe different facts and are not interchangeable.
- **Adapter interface**: `bin/code_hosting.ts` emits `schema_version=1` JSON envelopes for repository resolution, identity, PR/Issue/Review/Release facts and writes, CI facts/reruns, Markdown rendering, tree lookup, guarded merge, and branch deletion.

## Requirements

### REQ-CODE-HOSTING-001

- The system MUST derive one Repository Binding from the approved `BASE_REMOTE` and reject unknown hosts, malformed remote URLs, and cross-host or cross-repository input URLs.
- Inputs: SSH scp-like, SSH URI, or HTTPS Git remote and an operation-specific repository/PR/commit selector.
- Outputs: provider, host, owner, repository, selected remote, canonical web/API origins, or a typed failure.

### REQ-CODE-HOSTING-002

- The system MUST route `github.com` to the GitHub adapter and `git.ivanli.cc` to the Gitea adapter, with no task-text, arbitrary-URL, default-login, or local credential-file override.
- Gitea operations MUST use the matching Tea remote/login and use `tea api` when a high-level Tea command cannot preserve the required invariant.

### REQ-CODE-HOSTING-003

- The system MUST normalize PR, review, issue, release, CI, tree, Markdown, identity, and branch facts into versioned JSON results and preserve provider-specific raw facts without exposing credentials.
- Unsupported or unavailable capabilities MUST be represented explicitly and MUST NOT be converted into success.
- `get_pr_facts(number)` MUST retain complete related-fact collection as its default behavior. Callers that only need PR identity, refs, state, or merge identity MAY pass `include_related=false`; that result MUST omit top-level and raw `reviews`/`comments`, include `related_facts_status=not_requested`, and perform no related-collection request.

### REQ-CODE-HOSTING-004

- The system MUST perform guarded PR merge and cleanup against the live expected head: GitHub uses its expected SHA guard, while Gitea sends `head_commit_id`, rereads the merged PR and merge SHA, and verifies branch deletion with a bound not-found read.

### REQ-CODE-HOSTING-005

- The system MUST bind CI observation and permitted one-time transient reruns to the exact SHA and return the CI Facts Envelope. `policy_state` MUST be one of `required|none|unknown|unavailable`; `checks_expected` MUST be one of `yes|no|unknown`; `ci_evidence` MUST be one of `passed|failed|pending|absent|unavailable|not_applicable`; and `gate_effect` MUST be one of `blocking|non_blocking|not_applicable`.
- A non-empty readable required-context policy yields `policy_state=required`; an authoritative absence of required contexts yields `policy_state=none` and may produce `checks_expected=no`. Unreadable policy MUST remain `unknown|unavailable` with `checks_expected=unknown`; it MUST NOT be converted into a required-check failure or no-check success by the adapter alone.
- When GitHub's private-repository plan limit returns the exact protection-read `403` message, the adapter MAY confirm `policy_state=none` only from the same bound branch metadata response with the requested branch name and `protected=false`; all other unreadable protection responses remain typed observation evidence.
- Policy observation failure MUST NOT prevent independent status, check-run, and workflow-run reads when those surfaces are available. Runs with a different SHA, missing/unknown event, or `workflow_dispatch`, schedule, release, publish, deploy, or deployment event MUST be excluded from PR CI evidence. Malformed status/check payloads MUST remain typed unavailable evidence, and repeated context observations MUST reduce to the freshest timestamp/attempt/run identity. When timestamps are only partially present and attempts are equal, comparable run identities MUST break the tie before falling back to conservative outcome severity. Mergeability and conflict precedence belong to the live PR reducer, not this adapter.
- A permitted CI rerun MUST be keyed by provider, repository, run identity, and exact SHA. Concurrent requests for the same key MUST share the in-flight mutation; deterministic pre-send command or endpoint validation failures MAY release the allowance for a retry, while timeout or ambiguous mutation results MUST retain it. A rerun response is successful only when its observed HTTP status is a strict `2xx` and its returned run identity and SHA match the request.

### REQ-CODE-HOSTING-006

- The system MUST render and verify managed PR visual evidence through the selected platform, including immutable-SHA asset URLs and server-side Markdown rendering, without requiring GraphQL or browser automation for Gitea.

### REQ-CODE-HOSTING-007

- Initiative Contract v5 MUST require a GitHub Repository Binding and MUST return `unsupported_capability` before any external write when bound to Gitea.

### REQ-CODE-HOSTING-008

- New direct-flow receipts MUST store the Repository Binding and normalized provider facts; schema v5/v6 ledgers and historical GitHub command evidence MUST remain readable but MUST NOT be emitted by new operations.

## Verification

### VER-CODE-HOSTING-001

- Method: Adapter unit fixtures cover SSH/URI/HTTPS parsing, allowlist routing, cross-repository rejection, and matching Tea remote selection.
- covers: `REQ-CODE-HOSTING-001`, `REQ-CODE-HOSTING-002`
- Pass condition: Only the two supported hosts select a provider and every invalid or ambiguous identity fails closed.

### VER-CODE-HOSTING-002

- Method: Mocked GitHub and Gitea provider response fixtures exercise every normalized envelope, typed error, and the complete-versus-lightweight PR fact modes.
- covers: `REQ-CODE-HOSTING-003`
- Pass condition: Provider-specific fields normalize to the same semantic result, secrets never appear in output, and lightweight reads perform only the core PR request without fabricating empty related collections.

### VER-CODE-HOSTING-003

- Method: Merge, branch cleanup, CI status, Actions rerun, tree, and Markdown-render fixtures exercise both providers. CI fixtures cover required/passed, required/pending, required/failed, confirmed no-policy, provider policy `403`, invalid endpoint, malformed policy, stale SHA, malformed rows, direct Gitea task responses, excluded manual/release/deploy/unrelated runs, strict rerun status/identity, concurrent rerun claims, and deterministic pre-send claim recovery.
- covers: `REQ-CODE-HOSTING-004`, `REQ-CODE-HOSTING-005`, `REQ-CODE-HOSTING-006`
- Pass condition: Expected-head mismatches and stale SHA evidence stop the operation; policy observation failures remain structured while independent facts continue; excluded runs never create CI evidence; failed verification and unsupported capability stop the operation.

### VER-CODE-HOSTING-004

- Method: Flow receipt, merge preflight, Initiative guard, and replay compatibility tests run against new structured fixtures and legacy GitHub fixtures.
- covers: `REQ-CODE-HOSTING-007`, `REQ-CODE-HOSTING-008`
- Pass condition: Gitea Initiative entry cannot mutate; new receipts contain binding facts; legacy inputs remain read-only compatible.

## Related ADRs

- [ADR 0020: Bind Delivery Workflows to a Code Hosting Platform](../../adr/0020-code-hosting-platform-boundary.md)

## Visual Evidence

- None

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
- `../../solutions/workflow-issues/forge-transport-decoupling.md`
