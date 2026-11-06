# Orchestration

`TaskGraph` validates a dependency graph and marks historical superseded tasks outside the active schedule. `TaskOrchestrator` applies a bounded running capacity, blocks only successors of failed work, and keeps independent tasks runnable. Contribution tasks reach success through `merged`, acceptance and verification tasks through `passed`, and coordination tasks through `completed`.

The scheduler can optionally receive the existing core `Ledger`; when a matching core task exists it records `run.start` and `run.finish` facts using the core lock and atomic receipt chain. `recover()` returns interrupted in-memory work to `pending` so the caller can make a bounded retry decision.
