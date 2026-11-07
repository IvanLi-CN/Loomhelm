---
title: Promote stable project truth into human-facing docs
module: docs
problem_type: workflow_issue
component: project-docs
tags:
  - docs
  - workflow
  - project-docs
  - agent-memory
status: active
related_specs:
  - docs/specs/agent-memory-project-docs/SPEC.md
resolution_type: guardrail
---

# Promote stable project truth into human-facing docs

## Context

- `docs/specs/**` 与 `docs/solutions/**` 适合承载工程流程与 Agent memory。
- 人类维护者需要的是项目当前真相，而不是任务过程本身。

## Symptoms

- 一个主题被多个 spec / solution 反复触碰，但项目文档没有更新。
- 人类需要靠任务历史才能知道项目现在怎么工作。
- 变更明明已经稳定，却只存在于 task prose 或 review 语境里。

## Root cause

- 工程记忆与项目文档没有显式分层，导致稳定结论长期停留在 `specs` / `solutions` 中。

## Resolution

- 在收口前显式判定 `project_doc_disposition=none|update|create|defer`。
- 若变更形成了项目级当前真相，优先通过 `$project-doc-promote` 更新现有项目文档；只有没有合适承载面时才新建。
- 项目文档路径必须尊重项目已有的人类文档组织方式：通常是 `docs/**`，也可能是根入口文档；不要强推统一 taxonomy。
- `defer` 只用于本轮暂不落盘的少数情况，且必须记录原因、目标文档与后续动作。

## Guardrails / Reuse notes

- promote 的是稳定结论，不是任务日志、review 过程或 milestone 进度。
- `docs-migrate MODE=project-docs` 适合做历史文档 / 批量提升；日常收口优先用 `$project-doc-promote`。
- PR 路径下，相关的人类项目文档也应进入 `References`，与 `Specs`、`Solutions` 一起形成对齐链。

## References

- docs/specs/agent-memory-project-docs/SPEC.md
- docs/README.md
- skills/project-doc-promote/SKILL.md
