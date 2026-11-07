# ADR 0043: External source directory viewer

## Decision

The shared viewer exposes a generic read-only source-directory view. An operator may provide an absolute run-data directory; the service validates the directory and assigns a random `view-<id>` run identity. The identity is a presentation mapping only and never becomes an orchestration run or ledger authority.

The mapping reads the source directory directly, is served by the existing single user service, and is protected by the same local authentication and browser lease. It is removed when its view lease expires. The source directory is never modified, copied into formal `data/runs`, or included in scheduling, renewal, migration, or write APIs.

Examples use this generic capability; there is no example-specific service mode or demo branch.

## Consequences

- Every view must retain the canonical source path and a filesystem identity so replacement or symlink traversal fails closed.
- The mapping must be bounded by an explicit read-only lease and must not keep the service alive after the viewer closes.
- URLs contain only the generated view identity; source paths and credentials stay out of URLs and ordinary logs.
- A source directory with an unsupported ledger contract is rejected with a readable compatibility error.
