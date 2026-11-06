# Dispatch

`ThreadDispatcher` is the integration boundary for creating a task conversation. It accepts an injected adapter with only `startThread`, `setThreadName`, `startTurn`, and `readThread`; the Codex app-server implementation is supplied by the parent integration.

Each request identity is idempotent. A successful adapter identity is retained as `threadId`, initialization failures stay failed, and an unknown result stays unknown until `reconcile()` checks the existing thread. `retry()` requires an explicit `approve()` call and resumes a reconciled thread instead of creating a second one. The included `FakeDispatchAdapter` is suitable for protocol and failure tests without credentials or a live server.
