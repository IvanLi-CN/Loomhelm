# Review proof 去重与等待语义守卫

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- Shared review uses one read-only sub-agent per required lane in the current candidate. The receipt helper never starts that agent or reads task, child, or transcript metadata.
- 新风险是同一 candidate 重复启动同 lane reviewer，或在 SHA 变化后误用旧结果。

## 目标 / 非目标

### Goals

- 用 `repo_root + head_sha + base_sha + review_profile + wave_id + lane` 定义 canonical proof key。
- 每个 `wave_id + lane` 只允许一个 live/completed 等价的 read-only sub-agent review；不同 lane 可以并行。
- 固定使用 `wait_agent` 等待 sub-agent 终态，禁止主代理为 review 自行轮询或启动第二层 reviewer。
- 新 SHA 明确使旧 proof stale，并创建窄上下文新任务。

### Non-goals

- 不治理独立手动 review/fix 工具的 exec-session 生命周期。
- 不修改 CI tracker 或 GitHub 远端语义。

## 需求（Requirements）

### MUST

- shared reviewer 必须是 `fork_turns=none` 的 read-only sub-agent。
- 相同 wave/lane 去重键已有 live sub-agent 时只能 `wait_agent`；已有 valid completed receipt 时直接复用，不得重复 spawn；不同 lane 不互相阻塞。
- 只有 matching lane 的 terminal `completed` + strict structured result + clean current HEAD 才能登记 proof。receipt 不读取或依赖 Agent/task/child/session ID。
- head/base 改变后旧 result 应标记为 `input_stale`；新 fact set 创建新的 lane review，旧结果不能变成新 SHA proof。
- failed、timeout、interrupted、missing-result 与 invalid-schema 都是非 clear 终态；model unavailable 必须登记 `unavailable` attempt 并只按 model fallback ladder 继续。
- shared callers 必须统一引用 `review-proof-short-contract.md`，不得复制另一套生命周期。

## 功能与行为规格

- Launch: 主代理先查询/恢复同 key lane；不存在时创建一个 read-only sub-agent reviewer。
- Wait: 主代理通过 `wait_agent` 持有到终态，不把它包装成 GitHub shared wait-state。
- Record: completed result 使用活动 wave 的 `record --kind review --wave-id <wave> --lane <lane> --review-result-json <structured-result>` 登记；helper 只校验和持久化，不启动 reviewer 或读取 task/transcript 元数据。
- Replay: 同一 current base/head、wave、lane、profile 与 canonical structured result 的重复登记必须返回既有 receipt；任何不匹配的重放必须拒绝，不能覆盖 lane。
- 同一 current base/head、wave、lane、profile 与 `startup-unavailable` 分类的 unavailable attempt 也必须幂等返回既有 attempt，不得追加重复 fallback 审计记录。
- Refresh: candidate SHA 或 base SHA 改变即生成新 key；旧 result 只作诊断，不参与 gate。
- Repair: findings 交给 `main-agent`；reviewer 不写文件、不提交、不 push。

## 验收标准

- Given 同一 `proof_key + wave_id + lane` 已有 live task，When 任一 shared 入口请求 review，Then 只等待现有 task；其他声明 lane 不得被该 lane 串行阻塞。
- Given caller 试图把 Agent/task/child/session identity 作为 receipt proof，Then replay/static guard 必须失败。
- Given旧 task completed 后 HEAD 已变化，When 登记 proof，Then receipt 必须拒绝或标记 stale。
- Given task 非 completed 或 result schema 不完整，When 评估 gate，Then `review=unchecked`，不得 clear。
- Given repair push 产生新 SHA，When 重建 reviewer，Then 当前 epoch 的 `3` repair permit 不得重置；只有显式 `convergence-reopen` 才能创建新 repair epoch。
- Given 已消费的 repair wave 因新 SHA stale，When 发放下一 permit，Then 旧 permit 保持已消费并计入上限，新 permit 从 current ledger head 起算。

## 质量门槛

- unit/static tests 覆盖同 key 去重、新 SHA 不复用、nonterminal、dirty head、strict schema 与 shared caller 引用审计。
- `git diff --check` 通过。

## 参考

- `docs/specs/review-proof-ownership/SPEC.md`
- `skills/project-engineering-workflow/references/review-proof-short-contract.md`
