---
status: superseded by ADR-0034
---

# Bind Review Repairs to Approved Scope

Code review must discover defects without turning every useful suggestion into an unbounded implementation obligation. The prior review/fix loop could keep reopening because it did not distinguish a defect in the accepted work from a new design request.

## Decision

- An in-scope review finding is repaired only when it demonstrates a violation of the approved behavior, acceptance, or non-negotiable safety boundary, and the repair does not change the settled design or implementation scope.
- A finding whose remedy needs a new behavior, contract, or wider scope is a Design-Returning Review Finding. Ordinary repair stops and the task returns to design for a new decision and later implementation approval.
- A Review Observation is reported but does not block delivery, create a Repair Batch, or start another formal review wave.
- Missing or stale evidence concerns whether the current Candidate has been reviewed; it is not a finding and cannot be repaired as one. Existing current-candidate review evidence rules continue to govern that case.
- The rule applies to every current Candidate. It does not create old/new review modes or reinterpret history by version.

## Consequences

Formal review remains able to require genuine in-scope repairs, but it cannot expand the task autonomously. A Repair Batch stays bounded to defects in the approved work, and a design-level finding has one explicit destination instead of becoming another review/fix round.
