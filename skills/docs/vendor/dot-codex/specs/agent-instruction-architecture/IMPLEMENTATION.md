# Implementation

## Coverage

- Global instructions are reduced to risk policy and routing.
- Direct delivery uses one Step 1-6 shared module and four thin adapters.
- PR create and merge have separate ownership and shared diagnostic references.
- Historical planning entrypoints are retired from the public Skill surface.
- Static architecture and live model replay gates cover size and behavior.
- Shared Step 2 routing, continuation recovery, and the short global route now distinguish ADR decisions from the current Spec contract.

## Validation

- Run `python3 bin/instruction_architecture_check.py`.
- Run `python3 -m unittest bin/test_instruction_architecture_check.py`.
- Generate the pre-change artifact with the new runner while loading instruction files from the fixed baseline: `python3 bin/instruction_behavior_replay.py --live --runs 2 --model <model> --instructions-ref 4a2107acab1b1ac2dade8d543c3fbd1b04306434 --write-results <baseline.json>`.
- Run the candidate with `python3 bin/instruction_behavior_replay.py --live --runs 2 --model <model> --baseline-results <baseline.json>`.
- The fixed baseline artifact for `gpt-5.6-sol` is checked in at `replay/baseline-gpt-5.6-sol.json`; candidate acceptance is 20/20 with all risk cases passing and a rate no lower than the artifact.
- Run the repository's existing Skill, workflow, PR, review, browser, image, and visual-evidence checkers.

## Remaining work

None after all current-head checks and review proof pass.
