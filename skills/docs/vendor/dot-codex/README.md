# Docs 总览

`docs/` 用来承载**项目文档**。这里的主视角是“项目当前是什么、怎么理解、怎么维护”，默认面向人类阅读；具体路径、层级与拆分方式应尊重项目自身情况，而不是强推一套全局目录骨架。

## 阅读入口

- [工程流程指南](engineering-workflow.md)：执行流程、开发验证、review、合并发布和流程恢复。
- [主题规格](specs/README.md)：按主题查阅长期需求、实现状态与演进原因。
- [工程记忆](solutions/README.md)：查阅可复用的问题诊断和解决经验。
- [多任务流程设计](design/multi-task-flow/orchestration.md)：`multi-task-flow` 顶层流程的执行、数据和页面设计。

## 文档角色

- `docs/specs/<topic>/`：面向工程流程的 slug-only topic-level specification；`SPEC.md` 回答“这个稳定主题长期应该保持什么为真”，同目录的 `IMPLEMENTATION.md` / `HISTORY.md` 保存实现状态与主题局部演进。历史 ID-prefixed 目录继续可读。
- `docs/adr/<NNNN>-<slug>.md`：面向难逆转、非显然且存在真实取舍的架构或边界决定，回答“为什么这样选”；它可被 topic Spec 引用，但不替代当前规范。
- `docs/solutions/**`：面向 Agent 的可复用工程记忆，回答“下次遇到类似问题时不要再从零想一遍”。
- `docs/**` 里的其他项目文档：面向人类的项目真相，回答“这个项目现在是什么、如何使用/维护”。

## 组织原则

- 优先复用项目已有的人类文档结构与命名。
- 需要新文档时，优先放到最贴近现有主题的位置；不要为了对齐全局约定硬造目录。
- 若项目还没有清晰的人类文档入口，可以补一个最小索引，但入口文件名也应服从项目现有习惯。

## Promotion 规则

- `specs` 与 `solutions` 可以更细碎，因为它们承担工程记忆与流程对齐职责。
- 当一次变更形成了**稳定的项目级当前真相**，或后续人类维护者需要在不读 spec/solution 的情况下直接理解它，就应把结论整理到合适的项目文档中。
- 这类整理默认通过 `$project-doc-promote` 进行；历史文档或批量收敛场景则走 `$docs-migrate MODE=project-docs`。

## 当前仓库

- 本仓当前显式维护的工程记忆入口为 `docs/specs/`、`docs/adr/` 与 `docs/solutions/`。
- `docs/specs/` 现在是主题级规格目录；它不再把整份 `SPEC.md` 写成任务单。持久决策的完整取舍留在 ADR，topic 局部生命周期仍留在 companion docs。
- Initiative v1 的 tracker 入口是 `docs/agents/issue-tracker.md`，只支持 GitHub + `gh`。
- 后续若新增人类项目文档，应继续遵守“路径尊重项目自身情况、内容表达当前真相”的原则。
