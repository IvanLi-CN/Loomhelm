# Shared CI Tracking Contract

本合同是 shared Step 5 / Step 6、`$fast-flow`、`$flow-continue` 以及 PR publication/merge procedure 的唯一 CI 判定来源。入口 Skill 只提供阶段、仓库、分支和 SHA，不复制下面的状态矩阵。

## 1. 输入与事实边界

- 输入是 `phase + repo + branch + bound_sha`：`pr_head_ci` 绑定当前 `PR.head.sha`，`post_merge_target_ci` 绑定 `merge_sha` 与目标仓库/分支。
- 一个 tracker 只观察一个阶段和一个绑定 SHA 的适用 CI。只计入由该 SHA 触发的自动 `push` / PR 相关检查；`schedule`、`workflow_dispatch`、release、 publish、deploy、deployment 以及无关分支或 SHA 的运行一律排除。
- PR freshness/conflict 优先级使用 `pr-diagnosis-short-contract.md`：先确认 live PR 的状态、base/head 和 mergeability，再解释 CI 缺席。
- 适用 CI、required check 和 provider 策略是三类不同事实。workflow 文件存在、手动运行成功或 `gh pr checks` 显示 `no checks reported`，单独都不能证明 required check 存在或不存在。

## 2. 四字段状态模型

CI facts adapter 必须同时返回以下字段；它们不能互相替代：

| 字段 | 允许值 | 含义 |
| - | - | - |
| `policy_state` | `required` / `none` / `unknown` / `unavailable` | provider 是否读取到可用的 required-check 策略 |
| `checks_expected` | `yes` / `no` / `unknown` | 是否有权威事实表明当前阶段期待 required checks |
| `ci_evidence` | `passed` / `failed` / `pending` / `absent` / `unavailable` / `not_applicable` | 绑定 SHA 的适用 CI 证据现状 |
| `gate_effect` | `blocking` / `non_blocking` / `not_applicable` | 当前 CI facts 对 PR reducer 的门禁效果，不是 provider 错误等级 |

判定规则：

- `policy_state=required` 只在 provider 明确返回非空 required contexts 时成立；各 required context 全部有成功的 exact-SHA status/check/run 证据时为 `ci_evidence=passed`，否则按失败、运行中、缺席或不可用分别分类。
- `policy_state=none` 只在 provider 明确返回没有 required contexts、确认无保护策略，或通过同一分支的 `protected=false` fallback 时成立。此时无自动 CI 证据是 `ci_evidence=not_applicable`、`gate_effect=non_blocking`，可由 tracker 映射为 `CI_NOT_EXPECTED`。
- `policy_state=unknown|unavailable` 时，`checks_expected` 必须是 `unknown`， `ci_evidence` 必须是 `unavailable`，`gate_effect` 必须是 `not_applicable`。这只是 provider observation evidence，不能被 adapter 单独映射成 `CI_NOT_EXPECTED`、required-check 失败或项目 blocker；是否阻塞由 live PR mergeability、可见 required contexts 和其他门禁共同决定。
- 因此，Step 5C / merge procedure 不把 typed policy observation 单独当成 blocker；只有 live PR 的 freshness/conflict、可见 required contexts、缺席的已确认 gate 或其他独立门禁事实形成阻塞时，才返回相应 blocker。若这些事实没有形成阻塞，保留 observation error 并继续当前流程，但不能把 `unknown|unavailable` 改写成 `CI_NOT_EXPECTED`。
- `gate_effect=blocking` 只表示已经确认存在 required gate 且当前证据未通过、仍在运行、缺席或无法观察。`gate_effect=not_applicable` 表示 adapter 没有足够事实决定门禁效果，不表示“没有门禁”。

## 3. 策略来源与错误语义

- GitHub required-check protection `200` 是可读策略；`contexts` 必须是字符串数组。非空数组为 `required`，空数组为 `none`；`404` 是确认无该 protection policy。
- GitHub 私有仓库 plan-limit 的精确 `403` 只有在同一分支 metadata 返回请求分支名且 `protected=false` 时，才允许确认 `none`。fallback 失败、分支名不符或仍受保护时为 `unknown`，不得降级成 `checks_expected=no`。
- 其他 `401/403/429`、`5xx`、`invalid_endpoint`、command/provider failure 或超时为 `unavailable`；`200` malformed policy、未知 HTTP 状态或结构不完整为 `unknown`。
- policy 读取错误必须保留 typed `policy_observation.error`，并继续读取可独立读取的 commit status、check runs 和 workflow runs。错误不得掩盖已经获得的 exact-SHA 事实，也不得为了“补齐证据”触发 `workflow_dispatch` 或创建 replacement run。
- status/check response 缺少或格式错误的 SHA、行结构或语义字段时，必须保留 typed `ci_surface_unavailable`；声明了合法但错误 SHA 时必须拒绝该证据。workflow run 只保留绑定 SHA，并排除手动、schedule、release、publish、deploy/deployment 事件。workflow run 缺失或不认识的 event 也必须排除；不能把未知 event 猜成 `push`。status/check surface 通常没有 workflow event provenance，因此只能凭 exact SHA 和 required context 参与判断，不能反向证明某个 workflow run 的触发事件。
- 同一 required context 有多条 exact-SHA 观测时，若两条都有 timestamp，优先使用较新的 provider timestamp；若部分观测缺少 timestamp 且双方都有 `run_attempt`/attempt，优先使用较高 attempt，再使用 run id。旧失败不能覆盖更新的成功 rerun；无法比较新旧时按 `failed > pending > passed` 保守处理。rerun verify 与 mutation 必须通过 `include=true` 保留 provider HTTP status，并且只有真实 `2xx` 才能报告 `rerun_requested`。

## 4. Tracker 生命周期与公共结果

- `agent_type = "ci-tracker"`
- 每个 bound SHA 使用一个只读 `ci-tracker`，profile 为 `gpt-6-luna + low`；tracker 直接读取和轮询 provider，不创建 automation，不启动第二个 tracker，不写代码、不创建 PR、不改 labels/state、不写入已合并主干。
- tracker 从启动起拥有 `600 seconds`（10 分钟）bounded wait/polling budget，只轮询同一 SHA。head 变化会使旧 tracker stale，必须以新 SHA 建立新的 tracker。
- tracker 终态保持 `passed|failed|incomplete|unavailable`，与任务状态分离。PR 侧公共结果枚举保持不变：`CI_GREEN | CI_NOT_EXPECTED | NEED_CODE_FIX | INFRA_BLOCKED`。
- 终态映射必须经过 live PR reducer：
  - `required + passed` -> `CI_GREEN`；
  - 已证实 `none + not_applicable` -> `CI_NOT_EXPECTED`；
  - `required + failed` -> `NEED_CODE_FIX`；
  - 期待证据仍缺席、tracker 不可用或策略/证据无法在当前 live 门禁中完成分类 -> `INFRA_BLOCKED`，并附恢复锚点；但 policy observation error 本身不能单独制造这个结果。
- `workflow_dispatch`、replacement run、手动 Actions 成功结果和历史 assistant transcript 都不是缺失证据的恢复手段。只有已有 run 被 live facts 证明是同一 SHA 的瞬态基础设施故障时，才允许对该已有 run 做一次 rerun。
- rerun 的一次性预算由 bound tracker 持有；adapter 在同一进程内为同一 `provider/repository/run_id/SHA` 共享一个 claim。mutation 进行中到达的调用必须等待同一 in-flight promise；mutation 已发出后的后续调用必须拒绝再次尝试。确定的 `command_unavailable`、endpoint validation 等 pre-send failure 不消耗 allowance，timeout 或结果不明则保守保留 claim。独立 tracker 不得绕过这个预算创建第二次请求。
- rerun 验证请求与 mutation 请求均只有严格 `2xx` 才算成功；`3xx`、`4xx`、`5xx`、 timeout 和 unsupported response 必须保留 typed failure/unsupported observation。

## 5. Live reducer 顺序

这里的 live PR reducer 是 shared workflow 的判定边界，不是 provider CI facts adapter 的第二套 tracker。adapter 只返回四字段 envelope 和 typed observations；入口 Skill、publication procedure 和 merge procedure 只能引用本合同完成公共结果映射。

1. 刷新 live PR 的 `state/merged/draft/mergeable/merge_state/base_sha/head_sha`。
2. `DIRTY` / `CONFLICTING` 先进入 freshness/conflict path；冲突导致的 workflow 缺席不能被改写成 `CI_NOT_EXPECTED`。
3. 在干净且 head/base 仍绑定时，读取本合同的 CI facts，区分策略状态、证据状态和门禁效果。
4. 只有 live PR surfaces 明确显示 required contexts 或权威无门禁事实时，才把 CI 结果映射为 `CI_GREEN` / `CI_NOT_EXPECTED`；provider API 错误不替代 PR reducer。
5. 合并前只消费绑定 Candidate/PR head 的 `pre_merge` 证据；合并后必须绑定真实 Merge Receipt 的 `merge_sha`。

## 6. 恢复卡

tracker 必须返回 `phase`、`bound_sha`、`terminal_state`、`tracking_target`、 `external_locator`、`rerun_count=<0|1>`、匹配的 runs/checks、四字段 CI facts 与 `evidence`。等待预算耗尽、provider 不可用、策略不可读或证据缺席时，恢复卡必须说明：

- 哪个事实已确认，哪个事实仍是 `unknown|unavailable`；
- 是否存在 live required gate；
- 下一步是刷新 live PR、处理 freshness/conflict、继续等待同一 SHA，还是由主人处理 provider 权限/策略问题。

不能用“没有 checks”直接替代这些区分，也不能用普通等待或手动 dispatch 掩盖 unavailable。
