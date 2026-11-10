# Release workflows

`Candidate CI` runs `tools/release/compatibility.py check` for every pull request. Changes under a Skill source require the `release:skill` label and an increased Skill version; TypeScript CLI source requires `release:cli` and an increased `clients/typescript/package.json` version. Viewer and internal contract surfaces additionally require `release:viewer`/`release:contract` and monotonic `VIEWER_CONTRACT`/`CONTRACT_VERSION` markers.

`Compatibility Release` is an explicit `workflow_dispatch` path. It checks one exact merged SHA, computes `compat-vN` from the Viewer contract marker, performs a dry-run package check, and only publishes when the operator sets `publish=true` and provides the repository's npm token. It never rewrites source, release-ledger state, or historical run data.

The labels are gates, not release authorization. A compatibility publication still needs an exact merged SHA and an explicit dispatch; ordinary product releases continue through `Manual Release` and `Release`.
