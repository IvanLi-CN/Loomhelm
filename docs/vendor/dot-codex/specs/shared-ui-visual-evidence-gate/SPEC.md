# Shared UI visual evidence gate

## Context and Scope

This topic defines the durable separation between owner-facing visual assets, task evidence, and PR image publication. It covers the shared workflow from Storybook or UI evidence collection through PR Phase A and merged-PR Phase B. It does not define unrelated UI implementation or a current task's evidence set.

## Terms and Interfaces

- `Task Evidence Set`: deduplicated repo-relative image paths explicitly selected for one task; it is ephemeral Phase A input.
- `Managed PR Evidence Section`: the single visible `## Visual Evidence` section generated in a PR body and consumed by Phase B.
- `Same-Path Baseline`: the image blob at the same repo-relative path in the locked base commit; absence is reported as current-only.
- Interfaces: `$ui-visual-evidence`, the `pr_body_image_gate.py` Phase A/B helper, and `bin/visual_evidence_document.py migrate`.

## Requirements

### REQ-UIEVIDENCE-001

The workflow MUST keep `SPEC.md` `Visual Evidence` limited to normative owner-facing assets. A Task Evidence Set MUST remain an ephemeral task input and MUST NOT become a persistent Spec grouping or PR selector.

### REQ-UIEVIDENCE-002

Phase A MUST accept exactly one explicit selection form: repeated `--evidence <repo-relative-image-path>` or `--no-evidence`. It MUST reject missing, mixed, empty, non-normalized, or non-current image selections and MUST generate or replace the one managed PR `## Visual Evidence` section.

### REQ-UIEVIDENCE-003

Phase B MUST read only the existing managed PR `## Visual Evidence` section, bind its URLs to `baseRepository + mergeCommit.oid`, and MUST NOT rediscover images from Specs, Plans, history, or hidden metadata.

### REQ-UIEVIDENCE-004

Visual comparison MUST pair candidate images only with the same repo-relative path in the locked base commit, report RGBA differences and heatmaps, and preserve `current-only` or unreadable facts without guessing an unrelated baseline.

### REQ-UIEVIDENCE-005

The workflow PR publication and merge procedures MUST call the shared image gate for Phase A/B. Retired `PR: include/none` selectors and `## Visual Evidence (PR)` headings MUST be migrated only in documents already modified by the current task, without deleting assets or creating a migration-only task.

### REQ-UIEVIDENCE-006

When a meaningful visual change needs owner confirmation and readable same-path baselines exist, the workflow MUST provide one `reg-cli` HTML report covering all comparable pairs. Report inputs MUST be symlinks to existing immutable chat snapshots rather than additional image copies. A source MUST match the snapshot generator's `<repo-scope>/YYYY/MM/DD/<UTC-timestamp>-<name>-<token>` layout, with the filename date matching its date directory; arbitrary files under the asset root MUST NOT be accepted. Snapshot files MUST be independent regular files, not hard-link aliases. Files under any case spelling of a generated `reg-cli-reports` subtree MUST NOT be accepted as snapshot inputs. Each explicitly supplied source MAY come from a different valid repo scope; the output report's canonical repo scope is derived from the current repository directory using the snapshot generator's slug-and-hash format. Reports MUST live under the existing `$CODEX_HOME/user-inline-assets/<repo-scope>/YYYY/MM/DD/` layout with a dependency manifest and an audit path for detecting missing or modified snapshots. Creation and audit MUST enforce the repository/date layout and reject symlinked report-path components. The HTML report MUST include every comparable pair. Creation MUST verify every source snapshot still matches its captured SHA-256 digest after rendering, immediately before publication, and immediately after the atomic publication rename. If the post-rename check fails, creation MUST remove the just-published report only when its directory identity still matches the identity recorded before publication, then fail. Audit MUST continue to detect later snapshot modifications. Generated report, JSON, manifest, and diff artifacts MUST be independent regular files with one hard link, not symlinks or hard-link aliases; diff outputs MUST match the `diffItems` manifest and contain no unlisted files. Audit MUST reject report directories, dependency paths, and manifest filenames that resolve outside the asset root. The report does not replace the RGBA/heatmap facts or owner-facing image set required by `REQ-UIEVIDENCE-004`: before confirmation, show applicable baseline images, current images, and every available heatmap in chat, with the HTML report as an additional inspection view. Removing or modifying a referenced snapshot invalidates the report. The pinned `reg-cli` package and every transitive dependency MUST be version- and integrity-locked in a committed npm lockfile. Installation MUST use `npm ci`, the official npm registry, and disabled lifecycle scripts. Both phases MUST run inside an OS sandbox whose canonical writable scope is limited to report staging; network access MUST be denied during report generation and may be enabled only for installation. The install phase MUST NOT read staging inputs or source snapshots. Sandbox reads MUST deny file contents and directory enumeration under user home directories, temporary stores, mounted volumes, keychains, and non-runtime third-party tool roots, with explicit data access restored only for the private install runtime or, during comparison, staging, source snapshots, and required Node/npm runtime paths. Metadata reads needed to resolve allowlisted paths may remain available. Temporary files, npm cache, and process logs MUST stay in staging. The sandbox may allow process-fork when required by the pinned renderer, but all descendants MUST remain under the same filesystem, executable, and network restrictions. After the runner exits, staging MUST be atomically renamed before validation. Generated regular-file outputs MUST be APFS copy-on-write cloned into a fresh publication directory outside the sandbox write scope, then validated and published from that independent inode set; input snapshots MUST remain symlinks, and unsupported filesystems MUST fail closed rather than copy them. Creation and audit MUST reject any unexpected top-level report artifact. Unsupported platforms or missing sandbox support MUST fail closed without running `reg-cli` unsandboxed.

## Verification

### VER-UIEVIDENCE-001

- Method: visual-evidence gate unit/replay tests and `python3 bin/visual_evidence_document.py migrate` fixtures.
- covers: `REQ-UIEVIDENCE-001`, `REQ-UIEVIDENCE-005`
- Pass condition: normative Spec assets remain separate from task/PR selection and touched-file migration preserves legacy compatibility.

### VER-UIEVIDENCE-002

- Method: `skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py` and Phase A/B contract checks.
- covers: `REQ-UIEVIDENCE-002`, `REQ-UIEVIDENCE-003`
- Pass condition: explicit selection, managed-section replacement, merge URL rebinding, and no fallback discovery are enforced.

### VER-UIEVIDENCE-003

- Method: `skills/ui-visual-evidence/scripts/compare_visual_evidence.py` fixtures.
- covers: `REQ-UIEVIDENCE-004`
- Pass condition: same-path RGBA comparison reports dimensions, heatmap, current-only, and unreadable outcomes without crashing.

### VER-UIEVIDENCE-004

- Method: On macOS with `/usr/bin/sandbox-exec`, Node, and npm, run `REG_CLI_INTEGRATION=1 python3 bin/test_create_reg_cli_report.py` with the pinned `reg-cli` package.
- covers: `REQ-UIEVIDENCE-006`
- Pass condition: multiple snapshot pairs produce one readable HTML report containing every pair through symlink inputs, no input images are copied into the report, derived report files are rejected as future inputs, changed source hashes prevent publication, the complete npm dependency graph has integrity lock data, install and offline report execution are separately sandboxed, writes outside staging and through source symlinks or hard links are denied, directory enumeration under sensitive roots including `/Users` and `/private/var/tmp` is denied, detached writers cannot mutate published output inodes, unsupported platforms or filesystems fail closed, invalid report layouts, noncanonical repo scopes, symlinked paths or outputs, hard-linked report artifacts, duplicate result items, and unlisted input/diff/top-level artifacts are rejected, and audit detects missing or modified dependencies.

## Related ADRs

- [Task-scoped PR visual evidence](../../adr/0003-task-scoped-pr-visual-evidence.md)
- [Scope authority and topic Spec boundaries](../../adr/0004-scope-authority-and-topic-spec-boundaries.md)
- [PR Lifecycle Workflow Ownership](../../adr/0016-pr-lifecycle-workflow-ownership.md)
- [Sandboxed reg-cli report execution](../../adr/0022-sandboxed-reg-cli-report-execution.md)

## Visual Evidence

- None. This section is reserved for normative owner-facing assets; current task selections are supplied to Phase A explicitly.

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
