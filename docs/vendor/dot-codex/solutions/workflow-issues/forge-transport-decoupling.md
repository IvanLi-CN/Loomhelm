---
title: Decouple Code Hosting Transport from Delivery Workflows
module: codex-global-workflow
problem_type: integration
component: code-hosting-transport
tags:
  - code-hosting
  - github
  - gitea
  - cli
  - workflow
status: active
related_specs:
  - docs/specs/code-hosting-platform/SPEC.md
resolution_type: architecture
---

# Decouple Code Hosting Transport from Delivery Workflows

## Context

dot-codex delivery rules currently name GitHub and `gh` directly in several workflow and tracker contracts. Those names leak a provider implementation into otherwise provider-neutral work: determine a repository, publish a change, inspect a PR, collect CI evidence, and perform a guarded merge.

Git transport remains Git: `git fetch`, `push`, branch inspection, and worktrees do not need a code-hosting adapter. The adapter owns only the control plane that has platform-specific identifiers, URLs, credentials, APIs, and capability semantics.

## Resolution

Introduce one small code-hosting-platform boundary, selected before any platform API or CLI operation. Workflows call semantic operations rather than `gh` or `tea` commands:

| Semantic operation | Required normalized result |
| - | - |
| `resolve_repository` | platform kind, `web_origin`, `api_origin`, `owner`, `repo`, selected remote, canonical repository URL |
| `get_or_create_issue` | platform URL, numeric repository-local number, state, title/body |
| `get_or_create_pr` | platform URL, numeric repository-local number, base/head refs and immutable head SHA |
| `get_pr_facts` | open/merged state, base/head, head SHA, mergeability, reviews, comments, source URL |
| `get_ci_facts` | exact SHA, named check/run identity, state, conclusion, evidence URL, observed time |
| `submit_review` | review state, submitted SHA, comment/review URLs |
| `merge_pr_at_head` | merged state, resulting merge SHA, used expected head SHA |
| `render_asset_url` | platform-valid Markdown URL for a repository asset pinned to a ref |

The shared workflow must make policy decisions only from normalized facts. A platform adapter must never silently map missing facts to passing facts. An unsupported capability is a typed `unsupported_capability` result, not a fallback to another host or an ad-hoc browser operation.

### Repository and Platform Selection

1. Resolve the delivery `BASE_REMOTE` under the existing workflow's explicit remote-selection rules. Do not presume `origin`; a fork/upstream checkout can have several remotes.
2. Read its configured fetch/push URL with `git remote get-url`; parse standard SSH scp-like (`git@host:owner/repo.git`) and URI forms using a real Git URL parser, not prefix matching.
3. Canonicalize `host`, strip a terminal `.git`, and extract exactly one `owner/repo`. Reject a URL which cannot be represented that way.
4. Select a provider from a configuration-owned exact host allowlist, initially `github.com -> github` and `git.ivanli.cc -> gitea`. Do not infer provider from a repository name, organization, URL path, or a user-provided PR URL.
5. Bind every platform request to this resolved repository identity. A supplied Issue/PR/evidence URL must have the same normalized host and repository; an adapter rejects cross-host or cross-repository identity rather than acting on it.
6. Require an authenticated profile for that exact platform host before any external write. Auth setup, token creation, and login remain owner actions.

The host map should be data, not conditionals scattered across skills. Unknown hosts are read-only Git remotes until an adapter is explicitly added and the owner authorizes its use. The source of each repository's required CI policy remains an explicit design decision; a Candidate-controlled repository file cannot set that policy.

### Provider Implementations

`github` may retain `gh` for its normal CLI path. `gh auth login` supports a specific hostname, and `gh pr create` supports a `[HOST/]OWNER/REPO` repository selector. It should be invoked only by the GitHub adapter, never by a generic flow directly.

`gitea` may use the installed Tea CLI (`tea 0.16.0` observed locally) for ordinary operations. Tea has named logins stored in its own configuration; its entity commands accept `--login`, `--repo`, and `--remote`. The adapter should select an explicit named login from the resolved host, e.g. `--login ivan-gitea`, rather than depend on Tea's mutable default login or on ambient repository discovery. `tea logins add` also offers a Git credential helper; do not enable that implicitly because Git authentication is outside the platform adapter's authority.

Use provider REST APIs behind the same adapter when the CLI cannot preserve a workflow invariant or provide structured facts. Tea's documented local help exposes issue and pull create/edit/list, approve/reject/review, comments, and Action run/workflow commands, but `tea pulls merge` has no expected-head-SHA option. It is therefore insufficient for guarded merge by itself.

## Initiative Boundary

Initiative Contract v5 is GitHub-only. A Gitea repository binding must reject Initiative entry before creating a tracking issue, child issue, PR, or release record. The adapter does not attempt to simulate GitHub issue hierarchy through Gitea dependencies, checklists, or links.

## Capability Matrix

| Capability | GitHub implementation | Gitea implementation | Adapter rule |
| - | - | - | - |
| Issue CRUD | `gh issue` / GitHub REST | `tea issues` / `/api/v1/repos/{owner}/{repo}/issues` | Return repository-local number and canonical URL. |
| PR CRUD | `gh pr` / GitHub REST | `tea pulls` / `/api/v1/repos/{owner}/{repo}/pulls` | Read back base, head, and current head SHA after a write. |
| Reviews | `gh pr review` / GitHub REST | Tea approve/reject/review or `POST .../pulls/{index}/reviews` | Bind review facts to the reviewed head SHA where the provider supplies it. |
| Guarded merge | GitHub REST merge accepts `sha` | Gitea REST merge accepts `head_commit_id` | Refuse to merge unless live PR head equals the verified SHA; pass that same SHA to the merge request; re-read merged state and merge SHA. |
| Commit status | GitHub combined commit status and Checks APIs | Gitea commit statuses and Action-task APIs | Normalize status and workflow evidence, but preserve provider-specific raw fields. |
| CI runs | GitHub Actions check/run APIs and `gh pr checks` | `tea actions runs` and `/actions/tasks` | A named CI policy must declare its provider adapter and exact-SHA match. |
| Repository image | GitHub raw/blob URL form | Gitea `/raw/{ref}/{path}` or `/src/{ref}/{path}?raw=1` | Generate only via `render_asset_url`; never reuse a GitHub URL formatter for Gitea. |

### CI and Actions Are Not a Shared Contract

Both platforms expose commit statuses, and Gitea's API exposes workflow tasks with `head_sha`, event, status, and workflow identity. This supports an exact-SHA evidence model, but it does not make GitHub Actions and Gitea Actions interchangeable. Gitea documents Actions as mostly GitHub-compatible while listing differences: `jobs.<id>.environment` is ignored, complex `runs-on` is not supported, only `always()` is supported among expressions, and several GitHub token scopes are absent. Gitea runners are independently deployed.

Consequently, a workflow's generic rule can be “wait for declared CI evidence at the verified SHA”, while a provider/project-specific profile declares how a check is located, what success means, and whether Actions is even enabled. Do not hard-code a GitHub workflow event, check-run field, or Actions URL into the generic delivery contract.

### Image URLs and Attachments

GitHub CLI can upload PR attachments and rewrite local image references during `gh pr create`. That behavior is not a generic repository-image facility. Gitea resolves Markdown relative to its rendering context and supports raw repository content at `/owner/repo/raw/{ref}/{path}`; it also accepts the GitHub-like `?raw=1` redirect form from `/src/{ref}/{path}`. Gitea exposes Issue/PR attachments through its API, but Tea's PR creation help has no equivalent attachment flag.

The adapter must choose one of two explicit strategies per provider: a repository asset pinned to an immutable commit SHA, or a provider attachment whose returned download URL is recorded. Existing GitHub-only PR-body image normalization needs a Gitea formatter and renderer verification; it cannot be renamed and treated as portable.

## Unsupported or Separate Design Work

- GitHub Issue parent/sub-issue semantics used by the current initiative tracker have no demonstrated Gitea equivalent in this research. Gitea initiative support requires a separate tracker model (for example, local ledger plus explicit issue links) and acceptance contract; do not claim parity merely because both hosts have Issues.
- GitHub-specific surfaces such as GraphQL-only fields, rulesets, check-suite details, projects, and attachment behavior require explicit adapter methods or an `unsupported_capability` result.
- Platform API versions must be observed per target Gitea server. This note uses the Gitea 1.27 API documentation, but the adapter should query its instance version/read capabilities before relying on optional endpoints.
- A `tea` login is not a token authority delegation. The agent may inspect configured login status when authorized, but must not create tokens, log in, alter credential helpers, or print secrets.

## Guardrails / Reuse Notes

- Resolve platform identity once per operation and carry it as an opaque `RepositoryBinding` value. Do not reconstruct it from incidental URLs later.
- Keep Git remote mutation, Git push target changes, and platform writes behind their existing owner-authorization gates.
- Treat CLI output as an implementation detail. Adapters should request JSON when available and validate schema before normalizing facts.
- Preserve original URLs, raw provider responses, and observation timestamps as evidence, alongside portable normalized fields.
- Do not turn a generic delivery flow into a lowest-common-denominator flow: capability requirements belong to the operation contract and should fail clearly when a provider lacks them.

## Primary References

- GitHub CLI, [`gh auth login`](https://cli.github.com/manual/gh_auth_login): host-specific authentication and credential behavior.
- GitHub CLI, [`gh pr create`](https://cli.github.com/manual/gh_pr_create): repository selector, PR fields, and GitHub attachment behavior.
- GitHub REST, [merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request): expected `sha` merge guard.
- GitHub REST, [commit statuses](https://docs.github.com/en/rest/commits/statuses): combined commit status semantics and exact-ref lookup.
- Tea source repository, [Gitea Tea](https://gitea.com/gitea/tea): primary project source. Local `tea 0.16.0 --help`, `tea logins --help`, `tea pulls --help`, and subcommand help were consulted for CLI flags and command availability.
- Gitea 1.27 API, [API index](https://docs.gitea.com/api/): API surface and OpenAPI version.
- Gitea API, [merge a pull request](https://docs.gitea.com/api/operations/repo-merge-pull-request/): `head_commit_id` merge guard.
- Gitea API, [create a pull request](https://docs.gitea.com/api/operations/repo-create-pull-request/), [create a review](https://docs.gitea.com/api/operations/repo-create-pull-review/), [create a commit status](https://docs.gitea.com/api/operations/repo-create-status/), and [list action tasks](https://docs.gitea.com/api/operations/list-action-tasks/).
- Gitea documentation, [Compared to GitHub Actions](https://docs.gitea.com/usage/actions/comparison/) and [Actions overview](https://docs.gitea.com/usage/actions/overview/).
- Gitea documentation, [Markdown link-path resolving](https://docs.gitea.com/usage/repository/markdown/).
