---
name: loomhelm-release
description: "Use for Loomhelm Skill runtime releases, npm processing delays, known 409 recovery, release receipts, immutable tags, or dist-tag promotion."
---

# Loomhelm release

Use this project skill after a merged release PR or when a Skill Runtime release workflow has a non-success result. The protected workflow is the only npm write path; the local CLI performs identity and validation checks only. Treat a failed workflow as a state-machine checkpoint, not as permission to start a new build or upload.

## Release contract

The release identity is the tuple `@loomhelm/multi-task-flow`, exact SemVer, `compat-vN`, protected main merge SHA, build ID, `multi-task-flow-vX.Y.Z`, canonical tarball digest, and npm raw integrity. Keep one candidate tarball and one receipt for the whole release.

Treat the workflow receipt and live registry metadata as authoritative. A green candidate build, an npm command returning, a `known-409`, or a visible dist-tag alone does not prove publication. `published` requires exact package visibility plus package identity and digest agreement; `completed` additionally requires every requested dist-tag read-back.

## Procedure

1. Verify the merged PR, exact main merge SHA, release label, package version, compatibility line, and immutable tag precondition through `skill-release-publish.yml`.
2. Build and validate one candidate from that merge SHA. Freeze its tarball, build ID, canonical digest, raw integrity, and receipt; never rebuild during publish or recovery.
3. On an exact 404 plus an absent version in the package version index only, let the protected workflow perform the single initial `npm publish`. A successful command is `submitted`, not publication proof. If the version index already contains the version while exact metadata lags, reconcile read-only and never publish again.
4. Reconcile the same exact package with the workflow's staged backoff for about 15 minutes. `processing`, timeout, and known 409 mean the registry result is ambiguous; preserve the receipt and do not delete versions, move tags manually, or build another candidate. Unknown npm publish errors fail immediately with their captured npm output so infrastructure/auth failures do not masquerade as registry lag.
5. If the first reconciliation reaches `processing-timeout`, the workflow automatically performs one guarded republish of the same frozen tarball and another bounded read-only reconciliation. If that also times out, resume with the original run ID. The resume first checks exact visibility; if the package is visible it performs read-only identity reconciliation and never republishes. A second guarded upload is forbidden after `resumeRetryUsed=true`.
6. After exact identity, raw integrity, canonical digest, merge SHA, build ID, and tag identity all match, create or reuse the immutable Git tag. Promote `compat-vN`, then `latest`, then explicit `stable` only when requested; read back each tag before proceeding.
7. Finish only when the receipt says `state=completed`, `published=true`, `completed=true`, and the registry reports the expected exact version and dist-tags. Otherwise report the receipt state, npm outcome, and registry observation, then stop at the corresponding recovery gate.

## Recovery rules

Use `gh run download` to inspect the receipt artifact and `npm view @loomhelm/multi-task-flow@<version> --json` plus the package metadata endpoint for independent exact visibility checks. A delayed exact package may become visible after the workflow has failed; a later resume can perform read-only reconciliation when the candidate and receipt are unchanged.

Never use local `npm publish`, `npm dist-tag`, force tag operations, package deletion, a new build, or a manually edited receipt to repair a failed release. A second guarded upload is forbidden after `resumeRetryUsed=true`; continue read-only reconciliation or stop for owner/provider intervention. For an unknown publish error, inspect the workflow's captured npm stdout/stderr and fix the provider/auth/configuration cause before any retry.

## Completion evidence

Record the merged PR and merge SHA, successful workflow URL, package version, receipt state, package integrity, canonical digest, immutable tag target, `compat-vN`, `latest`, and explicit `stable` result. If `stable=false`, leave the existing `stable` tag unchanged and state that fact.

Detailed release contract and historical compatibility rules remain in `docs/specs/skill-runtime-release/SPEC.md`, `docs/adr/0030-skill-runtime-registry-reconciliation-and-consumer-dependencies.md`, and `.github/workflows/README.md`.
