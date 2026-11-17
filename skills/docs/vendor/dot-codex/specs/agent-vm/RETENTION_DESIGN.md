# Agent VM retention and voluntary release

This accepted design explains why Agent VM retention follows expected task continuation rather than individual validation phases. [REQ-AGENT-VM-009](SPEC.md#req-agent-vm-009--skills-and-operations) is the normative contract; [CONTEXT](../../../CONTEXT.md#agent-vm) owns the domain terms. This document is design background, not another operating entrypoint.

## Retention and closure boundary

Releasing after every validation would turn build-cache reuse into a race with global reclamation and repeat expensive setup during one continuing task. The accepted boundary is actual task closure: PR merge without further VM work, completion of non-PR work without expected follow-up, cancellation or a confirmed end to VM use. Readiness handoffs and ordinary waits do not establish that boundary by themselves.

An expected continuation is a reason to retain an effective lease, not an independent retention guarantee. An actively progressing Agent may explicitly renew for that use; execution interruption or returning control does not provide ongoing renewal. Expiry remains the fallback. The existing native lease and disposable stopped-cache semantics are unchanged.

## Responsibility and evidence

[agent-vm](https://github.com/IvanLi-CN/agent-toolkit/blob/main/skills/agent-vm/SKILL.md#retain-and-renew) owns the retention, renewal and Finish procedure. [project-engineering-workflow](../../../skills/project-engineering-workflow/SKILL.md#step-6-post-merge) invokes it at the relevant phase and closure points. This keeps one operating policy while preserving the engineering flow's independent review, CI and publication duties.

[Implementation coverage](IMPLEMENTATION.md#retention-and-voluntary-release-instructions) records candidate-document scenarios separately from native deployment and live-model evidence. Closure is established by observed lease/access/guest state; a command dispatch or prior expiry cannot substitute for that observation. Existing data-loss authorization remains unchanged.

All interview decisions are confirmed. This reversible instruction-policy clarification fits the existing native lifecycle decision and does not require a new ADR, CLI/control change, timer change or deployment.
