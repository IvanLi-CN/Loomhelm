# History

- Target advancement is separated from adopting a new review base: running review/CI rounds finish against their bound identity, then the parent handles accumulated drift. New-base adoption retains full fresh coverage; child reviewers report only, sharing the parent's repair count.
- Readiness requires executed evidence for changed critical boundaries. Placement and repair accounting are consolidated in the workflow and review-proof owners, without a task-specific boundary checklist or review ledger.
- Mandatory direct review evolved from universal proof to Agent-assessed tiers.
- Direct review evidence replaces receipt-led review orchestration so current diff review, validation, CI, and GitHub facts remain independently useful.
- Formal review moved behind a Review Readiness gate with runtime fresh launch; plans now express policy and profile recommendations rather than named reviewers. Repair refresh is delta-based with full refresh for uncertain, shared-contract, high-risk, or base-drift changes.
- Base-drift refresh now requires and records the observed replacement base SHA before accepting refreshed lane results.
- Readiness vocabulary and direct-plan fields now enforce the complete gate; terminal replay records require clear structured evidence and local-merge shares the same readiness prerequisite. Scope, actual profile, and unknown evidence fields now fail closed, and base-drift requires a changed base SHA.
- Direct-plan validation now rejects vague Tier 3/4 strategy/profile wording: the strategy must express runtime formal-lane creation or launch, and the recommendation must name a concrete supported model and effort pair.
- Review replay now fails closed on unknown disposition tokens instead of treating malformed evidence as report-only or repairable.
- Review replay now also requires explicit readiness evidence for launch and a demonstrated finding before an In-Scope repair can mutate the candidate.
- Structured review evidence now fails closed for unsupported actual profiles and unknown embedded finding dispositions.
- Repair replay now rejects observation-only evidence for an In-Scope batch, and direct formal policy fields cannot be duplicated ambiguously.
- Malformed or missing structured finding kinds now fail closed before terminal evidence is recorded.
- Terminal clear evidence may contain a blocking finding; `unchecked` is reserved for missing, stale, malformed, or unavailable review output.
- Repair eligibility now uses a priority-aware threshold: an initial-wave P2-only finding may be repaired optionally, later P2 repair requires a P0/P1 or qualifying current-Candidate CI trigger, and P2/P3-only results may clear with a recorded low-priority resolution and next-stop owner report.
