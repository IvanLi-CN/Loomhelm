# Workflow Execution Receipts Implementation

- `${CODEX_HOME:-$HOME/.codex}/bin/flow_receipt.py` stores validation and lifecycle facts below Git metadata; callers select the candidate with `--repo` and never copy the helper into the repository.
- Shared delivery skills use live GitHub facts, CI, validation, and direct review evidence without calling the ledger for review control.
- Receipt bind, target-ref, and post-merge lifecycle reads use lightweight provider PR facts; complete related review/comment facts remain available to callers that need them. Wrapped adapter failures preserve safe error code and operation metadata at the CLI boundary.
- Review-wave and repair state remains legacy compatibility behavior rather than an active direct-flow contract.
- Live merged PR facts are authoritative when a stored binding has drifted; historical review fields are not consulted to recover post-merge identity.
- A post-merge receipt may establish association when a ledger lacks a pre-merge bind timestamp. Closing still requires matching live `MERGED` facts and merge-SHA-bound finality, including a matching canonical repository binding and valid timezone-qualified RFC 3339 merge time; no pre-merge timestamp is synthesized.
- A new no-release receipt binds the policy evidence to the live repository, target branch, and merge SHA. Normalization verifies structure and explicit `release_expected=false`, not the truth of the cited policy. Old receipts remain readable but cannot newly seal complete without the evidence.
- Regression tests exercise lightweight lifecycle reads, typed CLI error provenance, late initialization through `init`, evidence-file normalization through the public record path, CLI dispatch into public `close`, and close failures for PR, repository, live merge facts, finality, and timestamp mismatches.
- `contracts/review-orchestration-retirement.md` maps the legacy review state machine, parser surfaces, source anchors, and test/replay assets that must be removed together when archive compatibility is retired.

## Verification

- `python3 -m py_compile bin/flow_receipt.py`
- `python3 bin/instruction_architecture_check.py --repo-root <candidate>`
- `git diff --check`
