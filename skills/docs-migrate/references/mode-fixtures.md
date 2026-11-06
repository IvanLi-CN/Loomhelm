# Docs-migrate mode fixtures

最小样例，仅用于快速确认五种模式的期望落点。

## Fixture A — `MODE=specs`

- Source: `docs/plan/ab123-api-cleanup/PLAN.md`
- Expected:
  - `docs/specs/api-cleanup/SPEC.md`
  - `docs/specs/api-cleanup/IMPLEMENTATION.md`
  - `docs/specs/api-cleanup/HISTORY.md`
- Keep: slug uniqueness、README catalog、删除前确认

## Fixture B — `MODE=specs-hygiene`

- Sources:
  - `docs/specs/s7gvk-pr-freshness-gate/SPEC.md`
  - `docs/specs/README.md`
- Expected:
  - `SPEC.md` 移除 task-ticket section，保留 topic-level 规范内容
  - `IMPLEMENTATION.md` / `HISTORY.md` 承接被拆出的实现状态与演进细节
  - README 从 `Status` 台账收敛为 `Lifecycle + Implementation` 的轻量 catalog
- Rule: active spec 不再把 `待实现/已完成` 之类状态写回 `SPEC.md` 或 README 的主 lifecycle，但实现进度与变更原因也不能丢，必须落在 companion docs；legacy ID 目录改名需 owner confirmation。

## Fixture C — `MODE=solutions`

- Source: `docs/notes/review-proof-timeout.md`
- Expected: `docs/solutions/workflow-issues/review-proof-timeout.md`
- Keep: frontmatter、`status`、`related_specs`、入站 Markdown 链接重写

## Fixture D — `MODE=project-docs`

- Sources:
  - `docs/specs/agent-memory-project-docs/SPEC.md`（或保留读取兼容的历史路径）
  - `docs/solutions/best-practices/project-doc-promotion.md`
- Expected:
  - 稳定项目结论被整理到项目自有的人类项目文档路径（通常 `docs/**`，也可为根入口文档）
  - 原 spec / solution 继续保留为 Agent memory
- Rule: 目标路径服从项目自身文档结构，不固定成全局 taxonomy

## Fixture E — `MODE=auto`

- Sources:
  - `docs/plan/x9k2m-port-rules/PLAN.md`
  - `docs/specs/s7gvk-pr-freshness-gate/SPEC.md`
  - `docs/notes/port-registry-learnings.md`
  - `docs/specs/agent-memory-project-docs/SPEC.md`（或保留读取兼容的历史路径）
- Expected:
  - legacy planning 文档走完整 canonical spec 目录：`docs/specs/port-rules/{SPEC,IMPLEMENTATION,HISTORY}.md`
  - 历史 spec cleanup 走 `specs-hygiene`
  - notes 文档走 `docs/solutions/workflow-issues/**`
  - 需要面向人类整理的稳定结论最后再走 repo 已建立的人类项目文档
- Rule: mixed taxonomy 先完成 `specs`，再做 `specs-hygiene`，然后 `solutions`，最后 `project-docs`
