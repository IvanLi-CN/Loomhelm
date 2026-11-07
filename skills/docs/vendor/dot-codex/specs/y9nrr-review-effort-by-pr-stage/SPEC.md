# Review model and effort defaults (superseded)

> 本目录仅保留历史兼容读取；当前模型选择合同以 `../workflow-agent-model-selection/SPEC.md` 为准，不得将本文作为现行策略。

## 背景 / 问题陈述

- review 模型和默认推理档位分散在 `$codex-review-loop`、shared workflow、`$pr-create` 与 `$pr-merge` 中，入口之间可能发生漂移。
- 主人已明确要求一般 review 默认使用 `gpt-5.6-luna` + `high`，关联 proof 默认使用 `gpt-5.6-sol` + `low`，高要求或疑难 review 使用 `gpt-5.6-sol` + `medium`。
- 仍需保留 agent 在 invocation 启动前一次性选择其他允许 effort 的能力，且不改变 proof、预算、sandbox 或 merge 流程语义。

## 目标 / 非目标

### Goals

- 统一 repo 内 review 的默认模型与 reasoning effort 口径，避免不同入口互相冲突。
- 按 review profile 明确 `gpt-5.6-luna` + `high` 的一般默认、`gpt-5.6-sol` + `low` 的关联 proof 默认，以及 `gpt-5.6-sol` + `medium` 的显式高要求档位。
- 保留 agent 在 invocation 启动前一次性自由改 effort 的权限，但禁止同一 invocation 中途调档。

### Non-goals

- 不修改 freshness gate、scope freeze、base-resolution 或 merge gate。
- 不修改 `--sandbox read-only`、`-a never`、CLI 参数顺序或 runtime sandbox 真相源规则。
- 不改变本机全局 `config.toml`、模型供应商或新增真实服务端 smoke test。

## 范围（Scope）

### In scope

- 更新 `skills/codex-review-loop/SKILL.md` 的模型、profile 默认、命令形状、改档语义与示例输出。
- 更新 `skills/project-engineering-workflow/SKILL.md` 中 dev-subagent、pre-PR local proof、PR convergence、merge-proof、local-merge-proof 的默认说明。
- 更新 `skills/pr-create/SKILL.md` 与 `skills/pr-merge/SKILL.md` 中 direct proof / convergence 的模型和默认档位描述。
- 更新本 spec 的 companion docs 与 `docs/specs/README.md` 索引摘要。

### Out of scope

- 更改任何运行时代码、MCP 选型或新增自动化测试框架。
- 修改 `$local-merge-flow` 的本地 merge 收尾业务语义。

## 需求（Requirements）

### MUST

- `$codex-review-loop` 的默认模型必须按 profile 使用 `gpt-5.6-luna` 或 `gpt-5.6-sol`，`review_effort` 输出契约必须接受 `low|medium|high|xhigh`。
- 固定请求形状必须为 `codex -m <resolved_model> -c model_reasoning_effort="<resolved_effort>" --sandbox read-only -a never review --base <BASE_REF>`。
- `dev-subagent`、`pr-convergence` 与 `fallback` 默认使用 `Luna` + `high`。
- `merge-proof` 与 `local-merge-proof` 默认使用 `gpt-5.6-sol` + `low`。
- 外层在首个进程启动前传入 `HIGH_REQUIREMENT_REVIEW=yes` 时，当前 profile 使用 `gpt-5.6-sol` + `medium`；该信号不改变 profile 或 proof key。
- `pre-PR local proof` 与 `pr-create` 中的 direct read-only proof 默认遵循 fallback/pr-convergence 的 `gpt-5.6-luna` + `high`；高要求/疑难场景必须在启动前传入 `HIGH_REQUIREMENT_REVIEW=yes`，切换为 `gpt-5.6-sol` + `medium`。
- `project-engineering-workflow`、`pr-create` 与 `pr-merge` 的模型、默认 effort 与 `$codex-review-loop` 保持一致。
- 每次 invocation 只能在启动首个 review 进程前解析一次 effort；后续轮次、重试与 restart 必须沿用同一结果。

### SHOULD

- 各入口应明确说明：agent 可在启动前一次性自由选择任一允许档位，而不将某个 override 描述为新的硬默认。
- 示例输出应覆盖一般 profile 的 `gpt-5.6-luna` + `high`、关联 proof 的 `gpt-5.6-sol` + `low` 与高要求信号下的 `gpt-5.6-sol` + `medium`，同时保留其他允许 effort override 示例。

## 功能与行为规格（Functional/Behavior Spec）

### Default matrix

- `dev-subagent`：默认 `gpt-5.6-luna` + `high`。
- `pre-PR local proof`：默认 `gpt-5.6-luna` + `high`；高要求/疑难场景传入 `HIGH_REQUIREMENT_REVIEW=yes` 后使用 `gpt-5.6-sol` + `medium`。
- `pr-convergence`：默认 `gpt-5.6-luna` + `high`。
- open-PR `merge-proof`：默认 `gpt-5.6-sol` + `low`。
- `local-merge-proof`：默认 `gpt-5.6-sol` + `low`。
- `fallback`：默认 `gpt-5.6-luna` + `high`。
- 任一 profile 在启动前收到 `HIGH_REQUIREMENT_REVIEW=yes`：使用 `gpt-5.6-sol` + `medium`，但保留原 profile 的 proof 与验证语义。

### Override semantics

- agent 可在启动某次 invocation 前一次性自由选择 `low`、`medium`、`high` 或 `xhigh` effort；模型按 profile 默认解析，只有 `HIGH_REQUIREMENT_REVIEW=yes` 才切换到 `gpt-5.6-sol` + `medium`。
- invocation 一旦启动，不得在同一次 proof / loop 的轮次、自动重启或卡死恢复中再次调档。
- 改档不改变 review profile、proof key、repair permit 或其他流程门禁。

### Cross-entry alignment

- 所有 direct read-only proof 与 writable `$codex-review-loop` 文案必须引用相同的模型和默认档位。
- 示例输出、总结模板与 merge-proof 文案必须与默认矩阵一致。
- 实际 sandbox mode 仍以 runtime banner / session output 为准，不从 CLI 参数字面值推断。

## 验收标准（Acceptance Criteria）

- Given 实现者检查 `$codex-review-loop` 输出契约 When 查阅模型、`review_effort` 字段定义与示例输出 Then 一般 profile 默认模型为 `gpt-5.6-luna` 且 effort 为 `high`，关联 proof 默认模型为 `gpt-5.6-sol` 且 effort 为 `low`，允许值包含 `low|medium|high|xhigh`。

- Given 实现者检查 shared workflow 的 Step 3E、Step 4、Step 5 与 Step 5L When 查阅所有 review 入口文案 Then dev-subagent、pre-PR local proof、PR convergence 与 fallback 默认 `gpt-5.6-luna` + `high`，merge-proof 与 local-merge-proof 默认 `gpt-5.6-sol` + `low`；高要求信号使用 `gpt-5.6-sol` + `medium`。

- Given 实现者检查 `pr-create` 与 `pr-merge` When 查阅 direct proof 与 convergence 文案 Then 各入口模型与默认 effort 均与上述 profile 矩阵一致，且高要求信号只在首个 review 进程启动前生效。

- Given 实现者执行静态 CLI 校验 When 分别运行 `codex --strict-config -m gpt-5.6-luna -c 'model_reasoning_effort="high"' review --help` 与 `codex --strict-config -m gpt-5.6-sol -c 'model_reasoning_effort="low"' review --help` Then 命令成功，且不发起真实 review。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: N/A
- Integration tests: 通过静态 CLI 解析、文档契约审阅与 grep 一致性检查验证
- E2E tests (if applicable): N/A

### Quality checks

- `git diff --check`
- `rg -n 'review_model=gpt-5\.6-(luna|sol)|review_effort=(low|medium|high|xhigh)|HIGH_REQUIREMENT_REVIEW' skills/codex-review-loop/SKILL.md skills/project-engineering-workflow/SKILL.md skills/pr-create/SKILL.md skills/pr-merge/SKILL.md`

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：未来新增 review 入口时可能遗漏共享模型/默认档位；实现时需用目标范围 grep 交叉检查。
- 假设：`gpt-5.6-luna` 与 `gpt-5.6-sol` 在当前本机 CLI/账号环境可用，静态 CLI 校验可验证参数解析，但不验证服务端账号可用性。
- 假设：`HIGH_REQUIREMENT_REVIEW=yes` 由外层在启动前根据高要求/疑难事实设置；自由改档只影响启动前的 effort 选择，不改变 profile 或 proof 语义。
