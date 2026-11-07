# Mainline baseline and topic branch freshness contract

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- repo 现有合同已经分别覆盖了显式 `$dev-plan` 的 flow lock（如 `docs/specs/dev-plan-default-fast-track-auto-lock/SPEC.md`）与 canonical git skill surface（如 `docs/specs/git-skill-convergence/SPEC.md`），但还没有一个长期主题专门定义“开发基线默认值”和“topic branch 新鲜度”的统一真相。
- 结果是三层语义可能分裂：运行时文案说“默认按主干”，计划输出里却可能只写抽象词，实际执行又可能继续停留在 detached HEAD、默认分支，或已经过时的 topic branch 上。
- 主人要求默认按“目标仓库主干基线”推进；若主人显式指定了 branch 或 commit，就必须原样尊重；若没有指定，则只有非常强的 Git 事实才应触发“也许不是主干”的确认。
- 这条规则既涉及显式 `$dev-plan` 的 owner-facing 合同，也涉及 shared workflow 在 Step 1/Step 4 如何准备并维持一个正确且不过时的开发上下文，因此需要独立 topic spec 统一收敛。

## 目标 / 非目标

### Goals

- 为显式 `$dev-plan` 新增“具体开发基线”合同：`Flow Decision` 必须写出 concrete branch 或 commit，不能只停留在“远程主干”“目标仓库主干”之类抽象表述。
- 固化默认基线决策：主人显式给 branch/commit 时原样保留；主人未指定时，默认解析为目标仓库主干的具体 ref，并优先输出 branch，只有 branch 不可用或主人明确给 commit 时才输出 commit SHA。
- 把计划阶段的非主干确认触发器收紧到两类强 Git 事实：唯一 open PR base，或显式 upstream 集成分支；除此之外默认按目标仓库主干基线规划。
- 把 shared workflow 的 Step 1 改成“先拿到正确且新鲜的执行上下文”：
  - 没有 topic branch 时，基于已解析基线通过 `$git-branch` 自动创建 topic branch；
  - 已有 topic branch 时，进入 spec/实现前先做一次 `$git-sync` 预同步；
  - Step 4 继续按既有 confirmed-base gate 复核并必要时再次同步。
- 保持 planner 合同、运行时文案、checker、replay fixtures 与 reusable solution 同口径，避免同一条规则在不同入口说法不同。

### Non-goals

- 不把 Step 4 的 factual `BASE_REF` 解析硬编码成永远优先 `origin/main`；release 分支、open PR base、upstream 集成分支等既有强事实优先级仍然保留。
- 不把“计划里必须声明开发基线”扩展到未显式 `$dev-plan` 的普通规划回复。
- 不引入新的 branch naming policy，也不修改 remote URL、upstream、push 目标、认证或传输配置。
- 不为这次规则调整新增 workflow glossary 或 ADR；长期真相继续放在 spec、solution 与 active workflow docs。

## 范围（Scope）

### In scope

- `docs/specs/README.md`
- `docs/specs/mainline-baseline-topic-branch-freshness/*`
- `AGENTS.md`
- `skills/dev-plan/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/git-branch/SKILL.md`
- `skills/git-sync/SKILL.md`
- `bin/plan_contract_check.ts`
- `skills/dev-plan/references/replay-cases/*`
- `docs/solutions/workflow-issues/git-skill-convergence.md`

### Out of scope

- `normal` / `fast-track` / `local-merge` 的业务终点语义重写
- GitHub PR merge/runtime 逻辑
- remote/auth/transport 配置变更
- `CONTEXT.md` 或 browser-only 术语扩写

## 需求（Requirements）

### MUST

- 显式 `$dev-plan` 产出的每个 `<proposed_plan>` 都必须在 `Flow Decision` 中声明 `开发基线`，且最终值只能是具体 branch/ref 或 commit SHA。
- `开发基线` 不得只写抽象默认策略词，例如“远程主干”“目标仓库主干”“主干基线”；若需要表达默认策略，可在说明文字中出现，但最终值必须落到具体 ref。
- 当主人显式指定 branch 或 commit 作为 base 时，计划输出必须原样保留该事实，不能被默认主干 ref 覆盖。
- 当主人未显式指定 base 时，计划阶段只允许以下两类强 Git 事实触发“可能不是主干基线”的确认：
  - 当前 topic branch 关联的唯一 open PR base；
  - 明确指向非 topic 集成分支的 upstream。
- 除上述两类强事实外，显式 `$dev-plan` 默认按目标仓库主干基线规划，并在最终计划中输出解析后的具体 ref。
- shared workflow 的 Step 1 必须支持两条路径：
  - 若当前没有 topic branch，且工作区状态允许安全切换，则先解析开发基线，再通过 `$git-branch` 从该基线创建 topic branch；
  - 若当前已经在 topic branch 上，则在进入 Step 2 前先完成一次 `$git-sync` 预同步。
- shared workflow 的 Step 1 若处于 detached HEAD、默认分支或其他“需要移动当前工作副本”的场景，而工作区又存在 dirty/歧义风险，仍必须阻断并只问 1 个关键问题。
- shared workflow 的 Step 4 必须继续执行既有 confirmed-base gate，并明确它是对 Step 1 上下文准备结果的第二次复核；若 branch 在 Step 1 已同步但到 Step 4 又落后，仍需再次 `$git-sync`。
- `git-branch` 必须允许调用方把“已解析开发基线”作为 `BASE_REF` 传入，用于从正确 ref 建立 topic branch，而不是默认假设 detached `HEAD` 就是正确起点。
- `git-sync` 必须明确：shared workflow 的 Step 1 topic-branch 预同步，与 Step 4 confirmed-base 同步一样，都属于可复用的“confirmed base sync”路径；Step 1 只是更早执行，不代表可以跳过 Step 4 复核。
- `AGENTS.md`、`skills/dev-plan/SKILL.md`、`skills/project-engineering-workflow/SKILL.md`、相关 flow/git skills、`bin/plan_contract_check.ts` 与 replay fixtures 必须表达同一条规则。

### SHOULD

- owner-facing 文案可以使用“目标仓库主干基线”描述默认策略，但要同时清楚区分：这只是默认决策规则，不是最终 `开发基线` 字段允许输出的抽象值。
- 新的 replay fixtures 应同时覆盖 branch 与 commit 两类正例，避免后续 checker 只偏向某一种 ref 形态。

## 功能与行为规格（Functional/Behavior Spec）

### 显式 `$dev-plan` 的开发基线合同

- `Flow Decision` 固定字段仍包含 `flow_type`、`flow_source`、`lock_status`；在此基础上新增 owner-facing 必填行：`开发基线`。
- `开发基线` 的允许值：
  - fully-qualified remote branch/ref，例如 `origin/main`、`upstream/release/2026-q3`
  - local branch/ref，仅当主人显式指定或当前上下文明确要求保留该本地 ref
  - full commit SHA
- `开发基线` 的禁止值：
  - 纯抽象策略词，如“远程主干”“目标仓库主干”“默认主干”“mainline baseline”
  - 缺失值、空值、`TBD`/`待确认`
- 解析优先级固定为：
  1. 主人显式给出的 base branch / commit
  2. 唯一 open PR base
  3. 显式 upstream 集成分支
  4. 目标仓库主干基线的具体 ref
- 当解析结果同时存在“默认主干策略说明”和“具体 ref”时，owner-facing 计划的最终值只写具体 ref；策略说明可以出现在 Summary / Assumptions 中，但不能替代最终值。

### shared workflow 的 topic branch / freshness 合同

- Step 1 的目标不再只是“确认当前就在 topic branch 上”，而是“让当前 run 在进入 spec / 实现前拿到一个安全、正确、不过时的 topic-branch 执行上下文”。
- 若当前没有 topic branch：
  - clean 且无风险时，先解析开发基线，再调用 `$git-branch ACTION=create-topic BASE_REF=<resolved-base>` 建立 topic branch；
  - dirty 或存在切换风险时，阻断并只问 1 个关键问题。
- 若当前已在 topic branch：
  - Step 1 先解析一个 provisional-to-confirmed 的开发基线；
  - 若该基线已经足够确认，则通过 `$git-sync` 先做一次预同步；
  - 若连 Step 1 都无法唯一确认真实 base，则阻断并只问 1 个关键问题，而不是带着旧 branch 继续实现。
- Step 4 仍然是 `可开 PR（local）` 的 confirmed-base gate：
  - 它必须重新 fetch / 复核 canonical `BASE_REF`；
  - 若 branch 相对该 `BASE_REF` 再次落后，必须再次 `$git-sync`；
  - Step 1 的预同步永远不能被当作 Step 4 已完成的替代证据。

## 验收标准（Acceptance Criteria）

- Given 显式 `$dev-plan` 计划里缺少 `开发基线` When `bin/plan_contract_check.ts` 检查该回放 Then 必须报出缺失开发基线的 finding。

- Given 显式 `$dev-plan` 计划把 `开发基线` 写成“目标仓库主干”或“远程主干” When checker 检查该回放 Then 必须报出抽象开发基线不合法的 finding。

- Given 主人没有显式指定 base，且仓库没有 open PR base / 显式 upstream 集成分支 When agent 产出显式 `$dev-plan` Then 最终计划应按目标仓库主干基线解析为具体 ref，而不是只写抽象词。

- Given 主人显式给出 branch 或 commit When agent 产出显式 `$dev-plan` Then `开发基线` 必须原样保留该 branch 或 commit。

- Given 当前 run 处于 detached/default branch 且没有 topic branch，工作区干净 When shared workflow 进入 Step 1 Then 它必须先解析正确 base，再通过 `$git-branch` 从该 base 创建 topic branch，而不是直接阻断。

- Given 当前 run 已在 topic branch 上 When shared workflow 进入 Step 1 然后 Step 4 Then Step 1 必须先做一次 `$git-sync` 预同步，Step 4 仍必须继续 confirmed-base 复核并在需要时再次同步。

- Given 当前 run 处于 detached/default branch 或需要移动当前工作副本，但工作区 dirty 或存在歧义风险 When shared workflow 进入 Step 1 Then 它仍然必须阻断并只问 1 个关键问题，而不是静默建分支或静默切换。

## 验收清单（Acceptance checklist）

- [x] 显式 `$dev-plan` 的 `开发基线` 合同已写清楚并落到 checker。
- [x] 默认主干策略与最终具体 ref 输出的区别已写清楚。
- [x] shared Step 1 自动建 branch / Step 1 预同步 / Step 4 再复核的双阶段 freshness 合同已写清楚。
- [x] dirty / detached/default-branch 风险场景仍保持单问题阻断。
- [x] replay fixtures 覆盖无显式 base、显式 branch、显式 commit、缺失基线、抽象基线五类场景。
- [x] reusable solution 与 owner-facing current truth 已同步。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `bun run bin/plan_contract_check.ts --cases skills/dev-plan/references/replay-cases/CASES.txt`
- `git diff --check`
- active runtime grep：确认 `AGENTS.md`、`skills/dev-plan/SKILL.md`、`skills/project-engineering-workflow/SKILL.md`、`skills/git-branch/SKILL.md`、`skills/git-sync/SKILL.md`、`skills/fast-flow/SKILL.md` 对该规则的说法一致

### Quality checks

- spot-check `Flow Decision` 示例，确认最终值只写具体 branch/commit
- spot-check Step 1/Step 4 文字，确认双阶段 sync 没被写成一次性 shortcut

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：如果只收紧 `dev-plan` checker、不修改 shared workflow，agent 仍可能在 stale branch 上继续实现，导致“计划写对了，执行上下文还是错的”。
- 风险：如果把“目标仓库主干基线”误写成永远等于 `origin/main`，会破坏 release / upstream / PR base 等既有强事实优先级。
- 假设：显式 `$dev-plan` 的 owner-facing 合同允许新增 1 条中文固定行 `开发基线`，而不需要再引入新的英文字段 schema。

## 参考（References）

- `docs/specs/dev-plan-default-fast-track-auto-lock/SPEC.md`
- `docs/specs/git-skill-convergence/SPEC.md`
- `skills/dev-plan/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/git-branch/SKILL.md`
- `skills/git-sync/SKILL.md`
- `bin/plan_contract_check.ts`
