# History

- 2026-11-17: 增加 Gateway 独立 HTML 故障恢复合同与源码实现，覆盖 Worker 完全不可用、限流倒计时、保留完整 URL 的手动重试与可指定 URL 场景的纯 Web Demo、独立静态构建；不改变 Ledger、诊断持久化格式或业务派发语义。

- 2026-11-11: Locked the unified atomic orchestration contract and implementation scope.
- 2026-11-12: Promoted the complete design into the topic SPEC and documented the implementation mapping, compatibility boundary and viewer entry points.
- 2026-11-13: Clarified the main-owned bootstrap start exception and fail-closed handling for uncertain or retained parent PR facts.
- 2026-11-13: Revalidated the topic contract after the mainline viewer and documentation synchronization.
- 2026-11-13: Closed bootstrap readiness consistently across engine, atomic validation and viewer projections, including provider identity, parent PR state and active workspace gates.
- 2026-11-13: Required explicit failed PR absence evidence and propagated DeliveryUnit gates into plan-level bootstrap readiness projections.
- 2026-11-13: Aligned engine bootstrap dispatch with the same explicit parent PR absence evidence required by validator and viewer.
- 2026-11-15: Added a fail-closed theoretical scheduling gate: plans with incomplete or indeterminate intervals cannot be approved or scheduled, incomplete viewers hide the timeline and list blockers, and user-visible planned time is relative hours from `0h` without date or timezone semantics.
- 2026-11-15: Required complete atomic graph rendering and stable derived detail ordering: invalid nodes and edges remain visible with diagnostics, DAGs use stable topological ordering, cyclic graphs use strongly connected component fallback, and the viewer does not persist a second display-order fact or automatic current-item emphasis.
- 2026-11-15: Expanded the topic contract to define separate state ownership for Run, AtomicNode, Task, DeliveryUnit, provider PR facts, operations and runtime resources; preserved merged capability after DeliveryUnit closeout; and specified audited closeout reconciliation, blocked recovery, successor DeliveryUnit revision and downstream impact handling.
- 2026-11-15: Split the review surface into SPEC.md, DATA_MODEL.md and STATE_MACHINES.md so the requirements contract, canonical data model and state/recovery diagrams can be reviewed independently.
- 2026-11-15: Locked Flow-native creation reconciliation as a separate recovery path from the standalone Codex dispatch journal, including evidence requirements, fail-closed unknown handling, idempotency and explicit exact-version release.
- 2026-11-16: Established the layered CLI contract boundary: repository documentation is the human-readable source, CLI help/schema are runtime surfaces, and the Skill references the packaged contract copy.
- 2026-11-17: Renamed the project-owned and vendored compound specification documents to underscore-separated names and synchronized their references, resource metadata and validation paths without changing the CLI contract or runtime behavior.

## Interrupted initialization recovery

采用 ADR 0038：显式单次初始化恢复与纯 creation reconciliation 分离；允许只有用户消息的 interrupted 握手，精确兼容历史角色文本，并对创建/恢复增加跨进程预算。恢复 attempt、原始 items 摘要和原生 recovery turn identity 追加保存，重入不重发，不改写旧 turn 或生产账本。
