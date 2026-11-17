# ADR 0036：Multi-task Flow CLI 契约的分层归属

## Status

Accepted; implementation is introduced with the versioned CLI contract surfaces.

## Context

Multi-task Flow 的持久化数据模型、CLI 输入 envelope、运行时 schema 和 Agent 工作流规则此前分散在 Skill、runtime source 和命令脚本中，Skill 还引用了不存在的 “data design document”。这会迫使正常编排回到 `engine.ts` 和 `orchestrate.ts` 查找命令细节，并且使 npm 包、安装后的 Skill 和仓库源码之间出现来源歧义。

## Decision

仓库中的 `docs/specs/multi-task-flow-unified-atomic-orchestration/CLI_CONTRACT.md` 是人类可读 CLI 命令契约的唯一手写来源。CLI/runtime 源码和测试是运行时行为与机器 schema 的权威来源。CLI 暴露 `flow --help`、`flow <command> --help` 和 `flow schema --format json`；Skill 只描述编排流程、权限、重试和对账规则，并引用发布包内的 `references/cli-contract.md`。npm 包可以携带由仓库源文档生成或校验的 Markdown 副本，但 CLI 运行时不生成或修改 Markdown。

## Alternatives

- 让 Skill 成为完整 CLI 字段契约的唯一来源：拒绝，因为 Skill 与版本化 CLI 行为容易漂移。
- 让 Agent 直接阅读 runtime source：拒绝，因为源码是诊断入口，不是正常调用接口。
- 让 CLI 运行时输出 Markdown 契约：拒绝，因为 CLI 应提供机器 schema 和 help，文档由仓库维护并随包分发。

## Consequences

正常编排可以通过 Skill、help 和 JSON schema 完成；源码阅读只在接口无法解释实际错误时发生。发布流程必须校验仓库文档、Skill 副本、资源清单和 package identity 的一致性。

## Verification

验证必须覆盖 help、schema、契约副本一致性、npm 资源清单、精确版本身份、命令 envelope 示例，以及 unknown、revision conflict、dependency pending 和 reconcile 路径。
