# PR freshness gate

> 当前有效规范以本文为准；实现覆盖见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## Context and Scope

PR 收敛需要同时避免两种浪费：在已知冲突或失效前提上继续验证，以及其他 PR 每次合入主干就重启进行中的 review。共享流程负责分清普通目标分支推进、实际候选变化与最终集成门禁；本主题不改变远端操作授权、CI/review 执行机制或仓库合并规则。

范围包括共享 workflow、PR publication/merge 与 continuation 的基线处理时机，以及 Step 1/4 对 `$git-sync` 使用显式只读 `ACTION=check` 的调用边界。公共 `$git-sync` 本身、外部仓库和运行配置不在修改范围内。

## Requirements

### REQ-PR-FRESHNESS-001

- 一轮 review 从绑定确定的 `base SHA + head SHA` 开始，到该版本所需 review lanes 和 CI 全部终态结束。finding disposition、修复和主干集成由父流程在轮外处理；不是每个子代理各自运行一个收敛循环。
- 启动一轮前必须刷新 live PR base/head。实际 `DIRTY` / `CONFLICTING` 必须先处理；required CI 被冲突抑制，或有证据证明接口、依赖、验证前提失效时，应立即诊断。候选写入仍须等待 owned review/CI tasks 终态。
- 普通目标分支推进或单独 `BEHIND` 不取消、不重绑、不重启正在运行的一轮，也不阻止其剩余 lane 启动。父流程记录最新目标，等待当前绑定的 review 和 CI 收齐结果。
- 轮末集中检查累计主干变化一次，将必要同步合并到下一个候选更新中。进入下一轮前处理实际冲突、已证实的集成不兼容和必须满足的 freshness 条件；不能仅凭本地分支落后就默认 rebase。
- Step 1/4 检查基线时必须显式调用 `$git-sync ACTION=check`，避免省略 `ACTION` 的默认 rebase。只有明确要求或有证据的集成需要才执行同步；同 topic upstream 的必要更新单独核对。
- 起始开发 SHA 不等于固定交付目标。必要同步受现有 flow 授权约束；固定目标冲突或缺少 history-rewrite 授权时立即报告 blocker，不自行扩权。
- 旧 checks、review proof 和 spec verdict 保留原始身份。实际 head 或采纳的 review base 改变后，必须重新绑定并取得所需证据；采纳新 review base 后刷新全部 required lanes，不自动跨 base 复用或重标旧结果。实际 live head 在轮内改变时诊断失效原因，先收束 owned tasks，再启动替代工作。
- PR body 修改仍满足 publication envelope 的当前身份检查。最终 Step 5C 和 merge 前必须刷新 live PR，并满足当前候选的 checks、review、validation、freshness 与仓库规则；不得把完成旧版本一轮审查视为当前可合并证明。
- 连续主干推进沿用现有等待预算和仓库集成机制，预算耗尽报告 blocker，不无限 rebase/review。修复累计预算沿用 `../pr-convergence-batching/SPEC.md`；纯基线更新不消耗行为修复批次，也不重置计数。
- `BLOCKED` 必须继续按 live checks、review policy、conversation 和 repository rules 判定；不能单凭该状态猜测 conflict 或缺 approval。stale-head / expected-checks / repository-rule merge 错误必须重新读取当前事实后路由。

## Verification

### VER-PR-FRESHNESS-001 covers: REQ-PR-FRESHNESS-001

- `bin/test_pr_skill_replay_check.py` 区分普通 `BEHIND` 与实际冲突：前者允许 bound review/CI 和剩余 lane，后者拒绝新启动审查；`UNKNOWN` 不清除已知冲突。覆盖 native、adapter 与 PTC 调用，用户引用不充当 live 事实。
- 回放中主干连续推进三次，原 head 不变时允许剩余 lane 和 owned wait；冲突诊断和既有 agent 等待仍允许执行。
- Instruction architecture 检查轮末集中处理、原始证据身份、父流程计数及有界集成规则，删除规则、仅放进代码示例或反转“不取消本轮”语义必须失败。
- 采纳新 review base 的测试仍要求新 base 绑定及全部 required lanes；最终 merge preflight 仍拒绝 stale expected base/head、冲突和未满足的 required checks。
- 这些是离线契约检查和回放，不是对 live Agent 工具调用的运行时拦截，也不证明真实任务耗时已降低。

## Related ADRs

None

## References

- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/project-engineering-workflow/references/review-proof-short-contract.md`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/project-engineering-workflow/references/pr-merge-procedure.md`
