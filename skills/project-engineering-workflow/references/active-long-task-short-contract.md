# Shared Active Long Task Contract

Use this contract for `AGENTS.md`, `$flow-continue`, shared workflow, native review tasks, and replay checkers that govern long-running tasks. Callers should reference it instead of restating the same ownership / stop / polling rules.

## 1. Active Long Task Definition

- An `active long task` is any still-running exec session, browser automation run, test/build job, remote job, tracker, advisory review, or equivalent live operation whose next meaningful step is to keep polling / relaying / waiting / same-path retrying.
- Dedicated contracts may add stricter semantics for specific subclasses:
  - Code-hosting-visible `外部门禁等待态` keeps its own shared wait budget and cadence.
  - a Tracker Agent or advisory reviewer may keep its own runtime handle and terminal-state rules.
- These dedicated contracts do not weaken the generic ownership guard in this file.
- CI, release, deployment, PR-status, and recovery tracking MUST NOT create, update, or reuse heartbeat, cron, or app automation. Wait on the dedicated tracker's runtime handle in the current chat; if it is unavailable, retain its identity/history anchor for owner-issued `$flow-continue`. Resource-lease renewal and explicitly authorized non-tracking handoffs retain their separate contracts.

## 2. Ownership Promise

- An `ownership promise` exists once the assistant says it will keep watching or continue the same live task, for example:
  - `我继续盯着`
  - `正在跑`
  - `我等它收口`
  - `我继续 relay/poll`
  - `我不切走`
- Equivalent wording counts even if phrased differently. The key meaning is: the assistant has accepted responsibility for continuing the same live task without needing new owner input.

## 3. Stop Prohibition

- If an active long task exists, and the only next step is still to poll / relay / wait / same-path retry that same task, the assistant must keep going in the same turn.
- It is not a valid stop point to say “still running”, “I’ll keep watching”, or any equivalent status-only summary while the same live task remains the only next action.
- The owner must not be forced to send no-op nudges such as `继续 / 盯着 / 别停 / 你自己处理` just to resume a task the assistant already promised to continue.

## 4. Legal Stop Reasons

- A non-terminal stop is allowed only when at least one of the following is true:
  - the task reached a terminal result (`completed`, `hard_dead`, explicit failure, timeout, or equivalent);
  - new blocker evidence changed the next action from pure waiting/polling to diagnosis or repair;
  - the next action requires fresh owner decision, authorization, or scope confirmation;
  - the applicable contract's wait budget is truly exhausted;
  - the current flow already reached its explicit user-approved stop condition.
- When stopping because wait budget is exhausted, the conclusion must explicitly say `等待预算耗尽`.
- For a live Tracker Agent, `等待预算耗尽` never becomes success; report its incomplete/unavailable terminal state and recovery anchor.

## 5. Polling Cadence Defaults

- Short 1-3 second polling is only for the first few observation cycles right after launch or right after a state-changing action.
- Once a local exec/browser/test/build task becomes a stable long task, callers should stretch cadence (for example `5s -> 10s -> 15s`) instead of indefinite `1s` busy polling.
- Dedicated contracts override cadence where they already define stricter budgets or polling intervals.
- Local commands have a default 1800-second hard budget. Only a repository-declared known-long command may override it.
- Identical effective inputs permit one transient retry only after observable state change. Output truncation, missing scrollback, or context compaction is not such a change.
- Nested skills inherit elapsed time and retry counters from the outer flow; they must not reset either budget.

## 6. Generic Continuation And Resume

- If a previous turn leaked an ownership promise anyway, the next generic continuation must resume the same live task first.
- Generic `继续 / 盯着 / 你自己处理` does not authorize a new route, a new launch, or a no-op pause; it only resumes the leaked task unless fresher direct evidence overrides it.
