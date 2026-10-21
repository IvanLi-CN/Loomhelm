# ADR 0006: Scoped credential administration

## Context

User API/MCP credentials inherit the user's current project permissions and may further restrict them to selected projects. The authentication implementation exposes credential creation, listing and revocation, but the public catalog does not yet describe these operations. Listing or revoking every credential owned by the same user through a project-scoped bearer would expose or affect authority outside its delegated project scope.

## Decision

Define the credential operations in the canonical REST/MCP catalog and keep authorization in the shared authentication application service. Listing and revocation are account-level operations limited to the current user's own credentials; they require an authenticated principal with no project-scope restriction. A project-scoped bearer receives `ErrForbidden`/HTTP 403 for both operations, even if it knows a sibling credential identifier. An unrestricted bearer and an authenticated browser session retain their existing user authority without receiving an installation role.

Creation retains bounded delegation: a project-scoped bearer must explicitly select a nonempty subset of both its own project scope and the user's current project permissions. An empty or omitted selection cannot widen delegated authority. An unrestricted principal can issue an unrestricted credential whose operations still follow that user's current project permissions, or select an authorized project subset. This decision introduces no independent credential-administrator role.

Use `GET /api/v1/credentials`, `POST /api/v1/credentials` and `DELETE /api/v1/credentials/{credential_id}`. Listing returns `items`, including an empty array when there are no credentials. Every credential carries `project_ids`; an empty array denotes no additional project restriction. Metadata never includes the raw token. Creation returns the secret once with HTTP 201; revocation returns a bodyless HTTP 204 for an owned credential, including an already-revoked one, and HTTP 404 for an unknown or foreign identifier. Cookie-authenticated writes remain behind the same-origin CSRF boundary.

## Consequences

Project-scoped Agents can delegate narrower credentials but cannot enumerate or disable the user's credential inventory. The owner can manage that inventory through an authenticated browser or an unrestricted user credential. REST and MCP expose the same service rules; no new product screen, global role or installation-management permission follows from the generated operations.

The public API impact is `minor`: the canonical catalog gains operations and types, while the scoped management rejection corrects an unpublished authorization defect. The persistent-state impact is `patch`: this decision changes no stored schema or token representation. Runtime authorization, scope revocation, secret handling and HTTP/MCP behavior require candidate-bound tests; generated clients do not establish those results.

## References

- [Phase-one product requirements](../PRD.md)
- [Phase-one specification](../specs/phase1-core/SPEC.md)
- [Versioned public protocol](0003-public-protocol-and-reconciliation.md)
