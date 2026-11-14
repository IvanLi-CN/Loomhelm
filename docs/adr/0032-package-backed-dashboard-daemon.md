# ADR 0032：npm package-backed Dashboard daemon

## Status

Accepted for the `@loomhelm/multi-task-flow` local Dashboard service; this ADR does not authorize npm publication, real-user upgrade or production deployment.

## Context

Dashboard currently has a one-shot CLI and a user-level service lifecycle, while older installations may contain executable release bundles under the service root. Keeping a second executable bundle beside the npm package creates two code identities and allows the launch path to diverge from the package selected by the user.

## Decision

The one-shot CLI and long-lived daemon are two execution modes of the same exact npm package. User-level launchd starts `bunx --bun @loomhelm/multi-task-flow@<exact-version> service daemon`; the service root stores configuration, package identity, ledger data, leases, logs and the plist, but does not copy a new service bundle as production code.

Installation and upgrade accept an exact SemVer, resolve the package, validate its self-reported artifact identity and persist that identity atomically. A daemon startup compares its self-reported identity with the persisted identity and fails closed on mismatch. Bun and production dependencies remain external package prerequisites.

An explicit package upgrade takes over an existing service profile by stopping the old user service, retaining data and port state, writing the new package identity and plist, and leaving old `releases/` files untouched and unused. The old bundle is not a compatibility, migration or rollback target.

`compat-vN` is the compatibility boundary for CLI, daemon, viewer and ledger contracts. Package SemVer differences inside one compatible line do not by themselves produce `INVALID_RELEASE`; incompatible contracts fail closed.

`status`, `doctor` and `ensure` may start a bounded, deduplicated registry update check. `login` consumes only the cached result. User-facing output contains `daemon_update` only after a confirmed newer daemon exists, with the compatible-line candidate and the `latest` candidate when they differ; failures, no-update results and unfinished checks remain silent.

## Consequences

The package version, artifact build ID and service identity have one executable source, while mutable service state remains durable and independent of package extraction. Startup needs network access to resolve the exact package, so launchd is explicitly on-demand with `RunAtLoad=false` and `KeepAlive=false`.

Legacy files remain available for owner-approved cleanup, but they cannot silently become an executable fallback. Update discovery adds a small cache and lock to service state, while its failures cannot change the primary command result.

## Verification

Package resolution, plist arguments, identity fencing, legacy takeover, compatibility behavior, update cache semantics and isolated macOS launchd behavior are verified by the package-backed service acceptance scenarios and the existing service contract suite.
