# Reviewer launch

A formal review lane is one fresh, read-only reviewer that inspects the Candidate and returns the canonical structured result. The reviewer runs in the same agent runtime as the flow, using the runtime's own sub-agent facility. No external CLI, no shell wrapper, and no host selection is involved.

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

## Launching a round

The flow launches every lane of a round with the runtime's own sub-agent facility, one fresh sub-agent per lane per round, and collects their terminal results before disposition. In an omp session that is the `task` tool with the bundled `reviewer` (or specialist) agent; another runtime uses its equivalent in-conversation sub-agent tool. This is not a choice among hosts: the flow uses whatever facility it is already running in.

The comprehensive lane and any specialist lane are separate sub-agents; none of them inherits another lane's context, findings, or session.

A round is terminal only when every lane has returned a terminal result. A partial arrival is not completion; keep waiting on the outstanding lanes.

Record `requested_profile` from the parent flow only. The reviewer's result carries findings and summary; it never reports an effective model as review evidence.

## When a lane cannot produce a result

Report the lane as unavailable with classification `startup-unavailable` and treat it as a blocker under the existing review-evidence rules. A sub-agent that cannot inspect the candidate, returns malformed findings, or fails to start is unavailable evidence — never a clear review, a lower tier, or a substituted reviewer.

The flow does not test alternatives ahead of time and does not choose among them. Because launch itself is the test, `startup-unavailable` is the only classification a direct flow needs; the concrete failure reason belongs in the blocker text, not in a new ledger field.
