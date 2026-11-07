# ADR 0022: Sandboxed reg-cli Report Execution

## Status

Accepted

## Context

The owner comparison report invokes a pinned npm package against symlinks to existing chat snapshots. The report generator must create HTML, JSON, and diff files without being able to modify the source snapshots or write outside the report's managed staging directory. Runtime caches and logs must not accumulate beside durable report assets.

`reg-cli` 0.18.16 and its npm dependency tree run against symlinks to existing chat snapshots. npm requires network access to install packages. The current macOS Seatbelt interface can express the required staging write scope, but `sandbox-exec` is deprecated and the profile language is not a documented third-party API. Runtime checks show that Node/Python abort when the profile grants only narrow read subpaths, so filesystem-wide read access must be paired with explicit denials for sensitive file contents and directory enumeration under user data and mutable external stores. Metadata remains available to resolve allowlisted runtime paths.

## Decision

- Keep input images as symlinks to immutable chat snapshots; do not copy them. Accept only independent regular files matching the snapshot generator's repo/date/timestamp path layout, and reject report-output path components case-insensitively. The default-deny profile also rejects hard-link aliases into staging.
- Commit `package.json` and `package-lock.json` with integrity data for `reg-cli@0.18.16` and every transitive dependency. Install with `npm ci`, lifecycle scripts disabled, and the official npm registry in a temporary directory beneath report staging, with a private staging-local `HOME` and npm cache. The install phase may use outbound network access but cannot write outside staging or read staging inputs and source snapshots.
- Run the installed `reg-cli` executable in a second sandbox with outbound network denied. Both phases use the canonical staging path as their only writable filesystem scope and may execute only the selected Node runtime. Permit renderer worker forks only within the same sandbox profile. Do not inherit custom CA path variables that would reopen arbitrary user-selected files during network-enabled installation.
- Deny file-content reads and directory enumeration under user home directories, `/private/tmp`, `/private/var/tmp`, temporary stores, mounted volumes, keychains, and non-runtime third-party tool roots. Reopen reads only for the install runtime during npm installation; the offline comparison phase may also read staging and the exact source snapshots. Metadata remains available for path resolution. Other operating-system file reads remain available because the supported Seatbelt runtime aborts under a strict read-subpath-only profile.
- Keep npm cache, temp files, and stdout/stderr logs in staging. Stop the process group and atomically rename staging before inspecting outputs. Clone report, JSON, and diff outputs with APFS copy-on-write into a fresh publication directory outside the sandbox write scope, recreate input image symlinks, and validate the clone set before publication. Reject generated report outputs as future snapshot inputs and recheck source hashes after rendering, immediately before publication, and immediately after the final rename. If the last check fails, remove only the just-published directory with the recorded inode identity. Require one hard link for each generated HTML, JSON, manifest, and diff artifact, and apply the canonical snapshot-scope syntax to report paths. Audit repeats source path and independent-file checks. Fail closed if the filesystem cannot clone outputs; never copy source snapshots. Remove the original sandbox staging after publication.
- Use macOS `/usr/bin/sandbox-exec` for now. If the required sandbox is unavailable or the platform is unsupported, fail closed; do not run the comparison unsandboxed.

## Consequences

- Report generation creates no persistent npm cache and no extra image copies, at the cost of installing the pinned package for each report.
- The implementation is currently macOS-only and depends on a deprecated, undocumented sandbox interface. Replacing it requires a separately validated sandbox backend; platform support must not be inferred from availability of a shell command alone.
- The Seatbelt profile retains read access to operating-system files; user-home and other excluded roots deny file contents and directory enumeration while preserving metadata lookups. Exact exceptions reopen runtime and task input paths. npm lifecycle scripts are disabled, install-time package bytes are integrity-locked, and the report execution phase is offline.
- The pinned renderer requires forked workers, so the sandbox allows process creation under the same narrow policy. A detached writer may still hold a descriptor to staging; copy-on-write output clones have independent inodes and live outside the runner's writable scope. Input images remain symlinks. Same-UID processes remain outside the sandbox boundary and can mutate a snapshot after the final publication check; audit detects later changes. Hash revalidation around publication prevents a detected in-flight mutation from being returned as a successful report but cannot make source snapshots immutable against a concurrent owner process. Concurrent path replacement during a file read or cleanup, and coordinated same-UID rewrites of a report and its manifest, remain outside the contract; audit checks consistency and accidental corruption, not cryptographic authenticity.

## Related Specs

- [Shared UI visual evidence gate](../specs/shared-ui-visual-evidence-gate/SPEC.md)
