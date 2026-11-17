# ADR 0033：Viewer worker 诊断与浏览器重连

## Status

Accepted for the package-backed Multi-task Flow viewer; implementation and release remain separate work.

## Context

Run dashboard requests cross the Stable Gateway and a Per-Run Versioned Worker defined by [ADR 0034](0034-stable-gateway-versioned-workers.md), with the daemon acting as their supervisor. A worker startup or connection failure can leave the gateway available while the affected run returns a timeout, empty response or generic `SERVICE_ERROR`. The browser can also retain an expired session or a stale error page after gateway or daemon restart, making recovery appear to be a viewer outage.

## Decision

Worker failures are runtime diagnostics, not Ledger facts and not business revision events. The viewer stores the latest diagnostic per run in a dedicated runtime state file protected by the existing service lifecycle boundary, retains it across daemon restart, records `recovered_at` after a successful health request, and removes stale entries only through a bounded runtime sweep.

Every diagnostic has a `diag-<UUID>` identity and records the run ID, worker key, worker generation, lifecycle stage, stable error code, safe summary, timestamps, retry count and recovery state. The gateway returns the same diagnostic identity in a machine-readable error response and exposes a read-only, run-authorized diagnostic endpoint. Logs and responses omit cookies, tickets, tokens, Ledger contents, absolute paths, complete commands and raw stack traces.

Worker recovery follows the existing three-restarts-per-sixty-seconds policy. A failure enters `observed`, bounded recovery attempts enter `retrying`, the restart limit produces `degraded` with fast deterministic failure, and a successful replacement request produces `recovered`. The gateway must not retry indefinitely or let one run's worker failure stop other runs.

The browser stops its refresh and SSE retry loop on `RUN_WORKER_UNAVAILABLE`, shows a copyable diagnostic card, preserves the run and tab identity, and offers a controlled reconnect that obtains a new login session and returns to the original view. It never performs unlimited automatic refreshes.

浏览器首次打开编排页而 Worker 不可用时，Gateway 自行返回 HTTP 503 HTML 故障页，页面及其脚本和样式不得依赖 Worker 资源。页面明确区分展示连接故障与任务执行失败，提供返回列表、复制诊断和折叠技术详情；重试按钮按 Worker pool 的实际剩余窗口倒计时，等待结束后仅允许手动刷新当前完整 URL，保留 run、plan、tab 和 fragment。刷新不得重派业务操作、清空失败计数或绕过重启限制。API、资源和非 HTML 请求继续返回 JSON 错误合同；响应以 `retry_after_ms` 和可用时的 `Retry-After` 表达等待时间。

## Consequences

Operators can correlate a browser error, HTTP response, runtime state and daemon log without exposing host secrets. The viewer gains a small runtime state machine and a recovery UI, while Ledger compatibility and business revision semantics remain unchanged. Worker lifecycle failures become explicit API behavior rather than opaque 503s.

## Verification

Acceptance must cover socket startup and connection failures, request and stream failures, restart exhaustion, daemon restart with an old browser session, successful worker replacement, multi-run isolation, and consistent diagnostics across HTTP, runtime state, logs and the browser. Resource, view and SSE requests must all use the same error contract.
