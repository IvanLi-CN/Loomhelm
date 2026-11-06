---
name: srv-101-ops
description: "Search machine 101 (`192.168.31.11`) directly from the current local repo name and git remotes, then inspect `/home/ivan/srv` before any SSH ops."
---

# srv-101-ops

Use this skill when the current working directory belongs to a local project that may be deployed on machine `101`.

## Purpose

This skill keeps application repositories free of deployment facts and does **not** depend on a local registry repository.

- Remote machine-level truth: `/home/ivan/srv` on `192.168.31.11`
- Search inputs: local repo basename plus git remote repo slugs
- Default posture: read-only inspection first, live changes only after explicit user approval

## Inputs

- Current local repo path or repo basename
- SSH alias `192.168.31.11`

## Helper

Resolve the current repo to remote search candidates with:

```bash
$LOOMHELM_TOOLKIT_ROOT/skills/srv-101-ops/scripts/resolve-target
```

Or point it at a specific repo/path:

```bash
$LOOMHELM_TOOLKIT_ROOT/skills/srv-101-ops/scripts/resolve-target /Users/ivan/Projects/Ivan/dockrev
$LOOMHELM_TOOLKIT_ROOT/skills/srv-101-ops/scripts/resolve-target --json blog-nextjs
```

## Workflow

1. Run `resolve-target` from the current project directory.
2. Always read these remote root docs first:
   - `/home/ivan/srv/AGENTS.md`
   - `/home/ivan/srv/README.md`
3. Let `resolve-target` search `/home/ivan/srv` using:
   - local repo basename
   - git remote repo slugs from the current repo
   - running Docker Compose labels when a matching container exists
4. Use the search result in this order:
   - validated running Compose labels, to confirm/narrow a stack or identify one when no active exact stack directory conflicts
   - exact stack directory matches
   - compose hits (`docker-compose.yml`, `compose.docker.yml`)
   - deployment cards whose filename matches the target slug
   - content-only deployment-card hits (`*.md` under a stack), as weak evidence only
   - maintenance hits (`/home/ivan/srv/maintenance/*.md`)
5. If exactly one stack candidate is found, inspect that stack first:
   - active compose file (`compose.docker.yml` preferred, then `docker-compose.yml`)
   - matching deployment card(s)
   - matching maintenance records
6. Read-only checks first:
   - `docker compose -f <compose_file> ps`
   - `docker compose -f <compose_file> logs --tail=200`
   - `docker ps --format ...` for matching containers
7. If multiple candidates remain after the evidence precedence above, stop and ask the owner to choose. A dependency-only deployment-card hit does not establish stack ownership.
8. If no deployment card matches the current project, do not deploy or roll back. Read-only inspection is allowed.
9. If the owner explicitly requests a live change, follow the matched remote deployment card and keep maintenance notes on the remote `~/srv` repo.

## Guardrails

- Do not depend on `/Users/ivan/Projects/Ivan/infra-101-ops` or any local registry file.
- Do not copy remote Compose files, secrets, deployment cards, or maintenance logs into local repos.
- Ignore remote legacy artifacts: `docker-compose.legacy.yml`, `quadlet/`, `PODMAN-*`, `MIGRATION-TO-QUADLET*`, `QUADLET-*`.
- Do not run `/home/ivan/srv/update-containers.sh` unless the owner explicitly asks for a bulk update.
- If search yields zero or multiple stack candidates, report that state clearly instead of guessing.
