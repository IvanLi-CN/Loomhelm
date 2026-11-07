# Code Hosting Platform Boundary 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖与兼容性事实。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: Adapter boundary and Gitea capability research are recorded; runtime migration is implemented locally.

## Implementation Coverage

- `REQ-CODE-HOSTING-001` / `REQ-CODE-HOSTING-002`: `bin/code_hosting.ts` resolves bound remotes and routes the two allowlisted providers.
- `REQ-CODE-HOSTING-003` through `REQ-CODE-HOSTING-006`: provider-neutral PR, review/comment, CI, merge, branch, tree, Markdown, and asset operations are implemented with focused fixtures. `get_pr_facts` keeps complete related facts by default and supports an explicit lightweight mode for lifecycle identity reads; lightweight results mark related facts as `not_requested` and omit related raw collections. Provider responses retain observation timestamps and recursively redacted raw evidence; Gitea CI reads `/actions/tasks` first and falls back to the compatible runs endpoint only when unsupported. Remote URI ports are scheme-specific, provider PR URLs are canonical HTTPS identities, and rendered visual evidence rejects HTTP/userinfo/non-default-port links.
- The active Bun adapter in `bin/modules/hosting/compatibility_ci.ts` and its policy/provider/normalization companions are the CI-facts runtime boundary used by the compatibility CLI. Focused fixtures live in `bin/tests/hosting/ci_facts.test.ts`, `bin/tests/hosting/ci_evidence_conflicts.test.ts`, `bin/tests/hosting/ci_rerun.test.ts`, and `bin/tests/hosting/hosting.test.ts`; the legacy Python boundary remains readable compatibility input.
- CI facts now return the four-field envelope (`policy_state`, `checks_expected`, `ci_evidence`, `gate_effect`). GitHub policy `403`, invalid endpoint, provider failure, and malformed policy observations remain typed in `policy_observation.error`; status/check/run reads continue independently. Exact-SHA validation remains fail-closed, malformed status/check/run rows remain typed unavailable evidence, normalized provider URLs are redacted before leaving the adapter, and manual, schedule, release, publish, deploy/deployment, unknown-event, and unrelated-SHA workflow runs are excluded from PR CI evidence. Required-context outcomes use timestamp/attempt/run identity with conservative partial-freshness handling; when equal attempts have only partial timestamps, a comparable run ID selects the newer observation before severity fallback. One-time reruns require exact identity, observed HTTP status, and strict `2xx` mutation acknowledgement; same-key concurrent calls share one in-flight operation, deterministic pre-send command/endpoint failures release the local allowance, and ambiguous outcomes retain it.
- `REQ-CODE-HOSTING-007`: Initiative authorization and live snapshot entry reject Gitea, unknown, malformed, and non-remote bindings before provider access.
- `REQ-CODE-HOSTING-008`: flow receipt schema v7 stores repository binding and normalized provider facts while legacy v5/v6 data remains readable.
- Verification commands: `bun test bin/tests/hosting`, `bun test bin/tests/checks/checks.test.ts --test-name-pattern="historical domain adapters cover the canonical case tables"`, the merge-preflight, Initiative, and visual-evidence script suites, and the dot-codex context validation. Provider evidence redaction, complete/lightweight PR fact modes, four-field CI classification, policy observation continuation, manual-workflow exclusion under required policy, direct task-array handling, malformed status/check rejection, conservative freshest-outcome selection, unrelated-head filtering, rerun identity/claiming, strict mutation status handling, and script-directory test invocation are covered.

## Coverage / rollout summary

- Supported providers are limited to GitHub and `git.ivanli.cc` Gitea.
- The adapter host allowlist is the single source for Gitea host recognition; Initiative checks and fixtures derive from it rather than duplicating the deployment hostname.
- Tea is already installed locally; no credential or platform configuration changes are part of this topic.

## Remaining Gaps

- Initiative v5 remains intentionally GitHub-only; adding a Gitea hierarchy model is a separate design.

## Related Changes

- [ADR 0020](../../adr/0020-code-hosting-platform-boundary.md)

## References

- `./SPEC.md`
- `./HISTORY.md`
