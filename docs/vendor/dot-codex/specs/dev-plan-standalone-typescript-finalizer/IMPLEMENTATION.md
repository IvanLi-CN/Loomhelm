# Implementation Coverage

## Current State

已实现 TypeScript 唯一业务路径与独立 finalizer；保留的 `plan-cli.sh` 仅承担安全启动和参数/stdin/退出码转发。

## Required Changes

- 将 dev-plan 的 shell checker、parser、projection 和 finalizer 逻辑迁移到 TypeScript。
- 保留一个只负责环境清理和 `exec` 转发的 `plan-cli.sh` 安全 launcher。
- 删除 dev-plan 与 `$multi-task-flow` 的 active route、handoff、digest、ledger 和 runtime bridge 绑定。
- 删除旧 shell 业务实现和对应的双实现测试路径。
- 将现有 raw-plan、projection、历史回放和安全启动测试迁移到 TypeScript 入口。
- 更新 Skill 文档、工作流文档、设计文档和索引，消除已退役的跨 Skill 绑定表述。

## Verification

- `bun test bin/tests/plan --timeout 30000`：74 tests passed。
- `bun test skills/multi-task-flow/tests/engine.test.ts skills/multi-task-flow/tests/orchestrate.test.ts --timeout 30000`：26 tests passed。
- `bun check bin/modules/plan/contract.ts bin/modules/plan/review.ts bin/plan_review_view.ts bin/plan_contract_check.ts`：无类型错误。
- `bun run bin/spec_contract_check.ts --path docs/specs/dev-plan-standalone-typescript-finalizer/SPEC.md`：通过。
- `git diff --check`：通过。
- 历史 JSONL 与 retired fixture 仍由 TypeScript 兼容入口只读解析；它们不参与新的 `$dev-plan` finalization route，也不创建 runtime 状态。

## Acceptance Boundary

新的 `$dev-plan` finalization route 已迁移并与 `$multi-task-flow` 解耦；兼容输入仍限于只读诊断，不得重新产生 handoff、digest、ledger 或 runtime bridge。
