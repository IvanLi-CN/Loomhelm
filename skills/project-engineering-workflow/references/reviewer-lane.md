# Reviewer launch

A formal review lane is one fresh, read-only reviewer that inspects the Candidate and returns the canonical structured result. The reviewer runs in the same agent runtime as the flow. No shell wrapper, no external agent CLI, and no host selection is involved; the runtime's own facility is used, including a runtime-provided review skill.

## Canonical result schema

The reviewer's final message is exactly this object. The flow rejects anything else and never remaps or guesses fields.

```json
{
  "overall_correctness": "patch is correct | patch is incorrect",
  "overall_explanation": "<one sentence naming the inspected implementation, diff, or contracts>",
  "overall_confidence_score": 0.0,
  "findings": [
    {
      "title": "<imperative, short>",
      "body": "<bug, trigger, impact>",
      "priority": 0,
      "confidence_score": 0.0,
      "code_location": {
        "absolute_file_path": "/abs/path/to/file",
        "line_range": { "start": 1, "end": 1 }
      }
    }
  ]
}
```

Top-level keys are exactly `findings`, `overall_confidence_score`, `overall_correctness`, `overall_explanation`. Each finding has exactly `body`, `code_location`, `confidence_score`, `priority`, `title`. `code_location` has exactly `absolute_file_path`, `line_range`; `line_range` has exactly `start`, `end`. `priority` is an integer 0-3, `confidence_score` is 0-1, and `absolute_file_path` must be absolute.

`overall_explanation` must pair an inspection verb (`reviewed`, `inspected`, `verified`, `read`) with the inspected object (`code`, `implementation`, `diff`, `change`, `test`, `contracts`). The flow rejects an explanation that reads as unavailable (`unavailable`, `unable`, `cannot`, `no evidence`, `no conclusion`) or that mentions no inspected object. The reviewer prompt must state those requirements, because they are part of the accepted result, not a post-hoc style check.

## Reviewer lane prompt

A lane prompt contains, in this order:

1. the canonical schema above, verbatim, with the instruction to return only that JSON object;
2. the approved scope, the candidate worktree path, and the exact base/head being reviewed;
3. the applicable contracts and acceptance clauses;
4. the validation evidence already collected for this Candidate;
5. the coverage checklist for the lane;
6. the bounded inspection budget: the exact files or paths to inspect, and the instruction to return a verdict once those and the base-to-head diff have been read;
7. for a repair round, the Scope Envelope and Repair Manifest, plus the instruction to inspect the complete current base-to-head diff rather than only the previous findings.

The prompt must state that the reviewer is read-only and must not edit, write, or run mutating commands.

A lane prompt without a bounded inspection budget produces unbounded exploration: a reviewer given only "review this change" kept issuing tool calls without converging. Name the files, the diff range, and the stop condition; the reviewer returns a verdict, not a reading program.

## Runtime support

Each runtime is used through a facility it already provides. The flow never installs a reviewer, shells out to another agent CLI, or selects among hosts.

| Runtime | Formal review | Repair owner |
| - | - | - |
| Codex | in-session sub-agent | main Agent |
| Claude Code | custom `reviewer` subagent; `/code-review` is advisory | `/code-review --fix` under an authorized Repair Batch, else main Agent |
| OMP | `task` tool with a schema-bound reviewer agent | main Agent |
| Pi | unavailable by default | n/a |

### Pi

Pi ships without a sub-agent facility, so a formal review lane cannot be isolated from the main conversation. Default behavior is to run no code review: record the tier assessment with `review=unavailable-runtime` and let the owner decide whether Tier 1/2 is acceptable for that delivery. Do not install a third-party sub-agent extension and do not wrap `pi -p` to fake a lane; both replace the runtime's own facility with an unreviewed dependency.

### Claude Code

Two facilities are available, and they are not interchangeable.

`/code-review` is the local review skill. It runs as a background subagent with its own context window, so the main conversation keeps its context, and it accepts a review target (branch, PR number, path, revision range), an effort level, `--fix`, and `--comment`. It applies its own procedure and reports findings as text or through its host findings list, never in the canonical schema below. Use it as an advisory pass and as a repair accelerator after disposition. It does not produce formal evidence: a result that cannot be read as the canonical schema is not a formal lane result.

Formal Tier 3/4 evidence uses a custom subagent instead. Copy `skills/project-engineering-workflow/agents/claude-reviewer.md` into `.claude/agents/reviewer.md` and launch it with this reference's lane prompt, the exact base/head, and the coverage checklist. It holds the canonical JSON and a read-only allowlist (`Read`, `Grep`, `Glob`, `Bash`); `Bash` is required because `git diff` is how the lane reads the base-to-head diff, and the prompt restricts it to read-only inspection.

`/code-review --fix` edits outside the session's checkpoints, so `/rewind` cannot undo them. Run it only when a Repair Batch is already authorized, and treat the resulting working-tree changes as an ordinary Repair Batch diff subject to the Scope Envelope rather than as review evidence.

### OMP

Launch every lane with the `task` tool, one fresh sub-agent per lane per round. The bundled `reviewer` agent cannot serve a lane as-is: it declares no `structured`, so its `output` schema stays inert while `task.structured` defaults to off, and its field names differ (`explanation`, `file_path`, `line_start`, `line_end`). Copy `skills/project-engineering-workflow/agents/reviewer.md` into `.omp/agents/reviewer.md`; it sets `structured: true`, the canonical schema, and a read-only tool allowlist without `edit` or `write`. A project agent overrides the bundled one by exact name.

The OMP reviewer does not repair. Its tool set and prompt both forbid edits, so every finding returns to the main Agent for disposition and the Repair Batch loop. That loop is the runtime's repair mechanism; OMP has no reviewed-finding autofix, and `omp cleanse` targets project diagnostics rather than review findings.

Drive the loop instead of hand-editing:

1. Classify every finding and write the Repair Manifest. Only mapped findings enter.
2. Spawn one fixer with `task` using the bundled `task` agent or a write-scoped project agent, passing the manifest, the allowed files, the invariant, and the regression check. It edits; it never reviews.
3. Run the manifest's regression check, then refresh the comprehensive lane against the new base-to-head diff. A new Candidate needs a new round.

Each cycle is one Repair Batch. Stop when the round returns no eligible finding, or return to design on a `Design-Returning Review Finding`. This is an automated loop with a human-auditable manifest, not a reviewer that patches itself.

## Launching a round

The flow launches every lane of a round with the runtime's own sub-agent facility, one fresh sub-agent per lane per round, and collects their terminal results before disposition. This is not a choice among hosts: the flow uses whatever facility it is already running in.

The comprehensive lane and any specialist lane are separate sub-agents; none of them inherits another lane's context, findings, or session.

A round is terminal only when every lane has returned a terminal result. A partial arrival is not completion; keep waiting on the outstanding lanes.

Record `requested_profile` from the parent flow only. The reviewer's result carries findings and summary; it never reports an effective model as review evidence.

## When a lane cannot produce a result

Report the lane as unavailable with classification `startup-unavailable` and treat it as a blocker under the existing review-evidence rules. A sub-agent that cannot inspect the candidate, returns malformed findings, or fails to start is unavailable evidence — never a clear review, a lower tier, or a substituted reviewer.

The flow does not test alternatives ahead of time and does not choose among them. Because launch itself is the test, `startup-unavailable` is the only classification a direct flow needs; the concrete failure reason belongs in the blocker text, not in a new ledger field.
