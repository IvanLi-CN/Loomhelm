# PR post-open scope freeze

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 现有 `docs/specs/pr-convergence-batching/SPEC.md` 已经解决了 PR 阶段的批量收敛、validation 预算与 checks 缺席诊断，但还没有约束“PR 打开后是否还能继续往里塞新的验收/UI/Story 改动”。
- session `019cea68-eaa5-75e0-aced-890e08d9b5c8` 暴露出一个典型问题：PR 很早就创建了，但后续长时间仍在同一个 PR 里继续做视觉/Story/交互收口，导致 PR 不只是收敛容器，而变成了持续开发容器。
- 现有流程允许 freshness gate 在 PR 后再次对齐主干；这条路径是必要的，但如果没有额外规则，就容易把“main-sync 带来的必要兼容修复”和“顺手继续做新的界面优化”混在一起。

## 目标 / 非目标

### Goals

- 在 PR 已打开后默认冻结范围，防止同一个 open PR 持续承载新的验收/UI/Story 扩张。
- 明确保留白名单例外：review-fix、CI/blocker 修复、behind/main-sync 带来的必要兼容修复、spec-sync 与纯视觉证据补录。
- 规定显式 same-PR reopen 的路径：允许主人明确要求“就在这个 PR 里继续扩范围”，但不能借此洗掉既有 PR convergence 预算。
- 与 `docs/specs/pr-convergence-batching/SPEC.md`、`docs/specs/pr-freshness-gate/SPEC.md`、`docs/specs/pr-wait-state-closeout/SPEC.md` 保持分层：本规格只补 post-open scope freeze，不重写已有 freshness/wait-state/budget 语义。

### Non-goals

- 不修改运行时代码或 `gh CLI` 远端操作契约。
- 不新增新的顶层三态字段。
- 不把截图替换、spec 证据补录这类纯 visual evidence 流程误判成 scope expansion。

## 需求（Requirements）

### MUST

- Draft PR 建立后，approved Goals 立即成为 scope contract，但允许在这些 Goals 内继续 planned implementation；不得把 Draft 当成无限扩 scope 授权。
- 只有 candidate head 进入 review/CI convergence 时才进入 `candidate freeze`，并应用原 post-open fix 白名单。
- 在 freeze 状态下，允许留在同一个 PR 内继续推进的改动只包括：
  - review-fix；
  - CI / blocker code fix；
  - `mergeable_state=behind`、`PR.base.sha` 前进、或 main-sync 导致的必要兼容修复；
  - spec-sync；
  - 不引入新产品行为/验收标准的 visual evidence 补录或替换。
- 在 freeze 状态下，默认不得把以下改动继续混入当前 PR：
  - 新功能或新增验收标准；
  - 新的视觉优化、交互重设计、文案 polish；
  - 新增 Story/示例/演示态，除非它们只是当前已接受行为的证据补录；
  - 与当前 review/CI/main-sync 无直接因果关系的 UI 收口。
- 泛化“继续 / 收尾 / 盯着 / 修一下”不能视为 scope reopen；只有主人显式要求“就在这个 PR 里继续做新的扩范围改动”时，才允许 same-PR reopen。
- same-PR reopen 必须回到本地 Step 3/4 重新收口，再回到共享 Step 5；不得在冻结中的 PR convergence 回合里直接边跑 review-loop 边扩范围。
- same-PR reopen 一旦显式批准，在“回到本地 Step 3/4 重新收口”的阶段内必须跨 turn 保持有效，直到同一个 open PR/topic branch 第一次带着这批 reopened work 回到共享 Step 5 并完成 publish-or-stop 判定，或被主人后续指令显式撤销/改成 follow-up PR。
- 这段跨 turn reopen 必须落进可恢复状态：PR 阶段状态区至少要持久化 `same_pr_reopen=active/inactive` 与 `same_pr_reopen_binding=<PR #>:<PR.head.ref>:<PR.head.sha>|none`，供后续泛化“继续”只在正确的 open PR/topic branch / head revision 上恢复。
- same-PR reopen 不会重置既有 `PR收敛修复轮次` 或 `PR预算绑定*`；只有现有绑定规则已经认定 `PR.base.sha` / workflow 事实变化时，才允许按既有机制重建预算。
- 若主人希望干净预算，必须拆 follow-up PR，而不是在同一个 open PR 里通过 reopen 归零预算。

### SHOULD

- shared workflow、`workflow PR publication procedure`、`$fast-flow`、`$flow-continue` 应使用相同的“允许留在当前 PR 的白名单”口径。
- 同步主干后的 UI 调整应从严判定：只有被 main-sync 直接逼出来的兼容修复才算 in-scope，不能把“顺手优化界面”混入白名单。

## 功能与行为规格（Functional/Behavior Spec）

### Core behavior

- 从 shared Step 3P 开始：
  - 多切片、慢 CI 或 UI 工作可在首个 repository-valid、targeted-tested、已提交切片后创建 Draft，然后明确返回 Step 3。
  - Draft implementation window 只允许完成 approved Goals；新增 Goal 仍是 scope expansion。
  - Step 4 candidate gates 完成后，Step 5A 复用 Draft、发布 candidate head 并切为 ready-for-review；此时启动完整 review/CI convergence 并进入 candidate freeze。
- 对每一轮 PR 阶段写入前，agent 必须先判断当前待改动属于：
  - `allowed same-PR fix`
  - `scope expansion`
- `allowed same-PR fix` 包括：
  - 当前 review findings 的直接修复；
  - 当前 CI/problem pack 的直接修复；
  - freshness gate / branch update / main-sync 导致的必要兼容修复；
  - drift/spec/evidence 补录；
  - 已经明确属于当前验收标准的证据性 Story/screenshot 刷新。
- `scope expansion` 包括：
  - 当前 PR 之外的新视觉要求；
  - 新的 Story 演示态；
  - 交互布局/文案继续打磨；
  - 与当前 review/CI/main-sync 无直接因果关系的“顺手再改一点”。
- 显式 same-PR reopen：
  - 主人明确要求继续在当前 PR 中扩范围时，允许退出冻结；
  - 退出后先回到本地 Step 3/4 重新收口；
  - 之后再回到该 open PR 的 Step 5，且继续沿用原 PR 的 convergence budget。

### Edge cases

- 若 `PR.base.sha` / workflow facts 改变，预算是否重建仍由既有 binding 规则决定；freeze/reopen 本身不提供额外预算豁免。
- 若视觉证据刷新本身引入了新的产品行为或视觉要求，就不再属于 visual evidence exemption，必须按 scope expansion 处理。
- 若 owner 只说“继续盯着”但同时提出新的 UI/Story 修改点，默认仍按 freeze 阻断，而不是自动视为 reopen。
- merge path、proof regeneration、以及同分支 auto-push 也必须重新应用 freeze gate；不能因为入口是 `workflow PR merge procedure` 就绕过 post-open scope freeze。

## 验收标准（Acceptance Criteria）

- Given open PR 已存在 When 新待办属于 review-fix、CI fix、spec-sync 或 main-sync 必要兼容修复 Then 允许继续留在同一个 PR 内推进。

- Given open PR 已存在 When 新待办属于视觉/交互/Story 的新增验收或 polish Then 默认按 scope expansion 阻断，不允许直接混入当前 PR。

- Given open PR 已存在且主人只说“继续/收尾/盯着” When 当前新增待办本质上是新的验收/UI 扩张 Then 不得把这句泛化继续解释成 same-PR reopen。

- Given open PR 已存在且主人明确要求“就在这个 PR 里继续做新的扩范围改动” When agent 执行 same-PR reopen Then 必须回到本地 Step 3/4 重新收口，并保留该 PR 已有的 convergence budget，不得归零。

- Given open PR 因 `mergeable_state=behind` 或 `PR.base.sha` 前进而重新同步主干 When 当前界面必须联动调整才能保持兼容 Then 这些调整可以继续留在同一个 PR 中，且不视为 scope expansion。

## 风险 / 假设

- 风险：`main-sync 必要兼容修复` 的边界存在主观性；默认从严判定，避免 same-PR scope creep。
- 风险：若主人坚持 same-PR reopen，PR convergence budget 会继续累计，可能更早触发 stop-loss；这是有意设计，不是副作用。
- 假设：视觉证据刷新与产品行为变化可以通过“是否改变既有验收标准”进行区分。
