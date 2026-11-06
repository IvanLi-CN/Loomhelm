# <人类可读标题>（legacy PLAN template）

> Legacy compatibility only. When canonicalizing, prefer `SPEC.md` under `docs/specs/` and keep the same topic-level structure.

## 背景 / 问题陈述

- 现状是什么？
- 为什么现在要明确这个主题级规范？
- 如果没有这份 spec，会产生什么长期歧义？

## 目标 / 非目标

### Goals

- ...

### Non-goals

- ...

## 范围（Scope）

### In scope

- ...

### Out of scope

- ...

## 需求（Requirements）

### MUST

- ...

### SHOULD

- ...

### COULD

- ...

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- ...

### Edge cases / errors

- ...

## 接口契约（Interfaces & Contracts）

- `None`，或按需链接到 `./contracts/*.md`

## 验收标准（Acceptance Criteria）

- Given ... When ... Then ...

## 验收清单（Acceptance checklist）

- [ ] 核心路径的长期行为已被明确描述。
- [ ] 关键边界/错误场景已被覆盖。
- [ ] 涉及的接口/契约已写清楚或明确为 `None`。
- [ ] 相关验收条件已经可以用于实现与 review 对齐。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: ...
- Integration tests: ...
- E2E tests (if applicable): ...

### Quality checks

- Lint / typecheck / formatting: ...

## Visual Evidence

- Follow the same rules as canonical `SPEC.md`.
- PR image selection is task-scoped: pass explicit `--evidence` paths or `--no-evidence` to `pr_body_image_gate.ts`; do not add selector lines or a `## Visual Evidence (PR)` section.

## Related PRs

- None

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：...
- 需要决策的问题：...
- 假设（需主人确认）：...

## 参考（References）

- 相关链接/文档/讨论：...
