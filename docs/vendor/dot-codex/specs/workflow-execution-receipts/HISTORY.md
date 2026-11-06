# Workflow execution receipts 演进历史

> 这里记录会影响 Agent 理解长期合同的关键演进；规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- Late-initialized or pre-merge unbound ledgers may close from a post-merge receipt matching the repository-bound live `MERGED` PR and merge-SHA-bound finality. The current repository identity and a valid timezone-qualified RFC 3339 merge time are revalidated at record and close. `pr_bound_at` remains evidence of an actual OPEN binding and is not synthesized during recovery.
- Regression coverage now passes through ledger initialization and public evidence loading and close/CLI entry points, and verifies failed close attempts leave the ledger active.

- Active instructions use the runtime-home receipt helper with `--repo`; the architecture check rejects target-relative helper paths without maintaining command, decoder, or wrapper allowlists.

- Review orchestration moved out of the receipt ledger. Receipts retain local validation and lifecycle audit value while direct review uses current structured evidence.
- The review-orchestration retirement inventory separates code safe to retain for validation/lifecycle from review-only legacy groups, so later deletion is deliberate and complete rather than inferred from the helper name.

- Direct delivery validation no longer uses synthetic Git repositories or temporary `CODEX_HOME` paths. Only current-candidate facts may create or consume flow proof; isolated state-machine exercises are outside the delivery gate.
- Active manifests that retained synthetic flow-receipt validation are migrated at their next gate, preserving their original manifest as read-only history; archived receipt bytes remain unchanged.

- Acceptance manifest 将 local `validation` 与远端 `delivery` 验收分门别类；旧清单默认 local gate，使 existing plans 无需迁移。candidate head 只在成功干净的 pre-PR validation receipt 落盘时推进，避免 init 与 PR bind 的身份错位重跑。

- Legacy receipt schema v3 may contain non-current fallback records. Current flows separate preferred workflow model/effort suggestions from resolved runtime profiles and retry an unavailable explicit override only with a different explicit pair; v2 Terra authorization remains read-compatible but is not accepted for new flows.

- Native v3 review receipts now require `resolved_model` and `resolved_effort` from the tool-observed task envelope, rejecting missing or mismatched runtime profile evidence before lane registration.

- owner 的 `convergence-reopen` 授权覆盖当前 PR 的首个受限 repair round；该 round 提交并推送后，账本以一次性、PR 事实绑定的 head bridge 进入 initial review，而不重复索取同一意图授权。bridge 不重置 repair 或 validation 预算。

- validation scope 改由单张 receipt 的 manifest/evidence 覆盖自动派生，移除调用方 CLI override；规范化 evidence 纳入 execution identity，允许多张 targeted receipt 组合验收，并禁止 cross-head attestation 复用不同 evidence；review wave 同时在写账本前拒绝固定 SHA base-ref、在最终 lock 内重验 moving ref，以避免终态不可收口。

- shared review proof 改由 `record --kind agent-review` 登记原生只读任务结果；receipt 不再为 shared flow 启动第二层 `codex exec`，旧 `record --kind review` 仅保留独立手动兼容。
- native review profile 由 v3 caller envelope 升级为 v4 transcript-derived attestation，禁止通过 preferred/resolved 差异推断 fallback。
- 验收证据从计划严格映射为 manifest，并由 validation receipt、synthesis 和 merge proof 逐项闭合；历史归档保持不可变，活动 v2 ledger 在 merge proof 前补登记。
- routine lane model/effort 改为严格相等；Terra 只能通过 Luna unavailable 与主人授权绑定的 epoch mutation 启用。
- Luna unavailable 证据改为快照验证并在原子更新区复核哈希，避免授权等待锁期间的文件替换使账本哈希脱离已验证内容。
- 将 proof reuse 从 raw chat/SHA 推导改为 explicit receipt + current-head delta attestation。
- 将 review convergence 从嵌套轮次改为一个不可重置的外层预算。
- 将 ledger 放入 `git rev-parse --git-path codex-flow`，不增加 repo-tracked runtime state。
- attestation 不再信任调用方自报 paths/fingerprints，而是从 source receipt SHA 到 current HEAD 计算 Git delta 与 effective merge fingerprint。
- validation `record` 使用 helper-owned command runner；1800 秒预算由进程组 timeout 执行，known-long 只接受 tracked exact-command declaration。review `record` 以固定 read-only/no-approval 参数直接启动 Codex review，并从 JSONL、exit、final message 与 clean HEAD 派生证据，拒绝调用方 shell command 和自报运行事实。
- repository-bound proof 只接受 helper 在干净 current HEAD 上实际执行的结果，Git tree 进入 effective-input fingerprint；日志限制在 ledger 专用目录，terminal run 拒绝后续写入。
- `SPEC.md` 的 `## Visual Evidence` 变化与契约正文分开分类，使视觉证据可 scoped rebind 而不放松 Spec contract 失效规则。
- proof lookup 使用不含 Git tree 的 stable key 关联跨 head 候选证明，执行 identity 则包含 Git tree；因此代码输入变化会重跑，而纯文档变化仍可经 current-head attestation 复用。
- 同一 execution identity 的 preflight、执行与落盘由跨进程锁覆盖，不同 identity 保持可并行。
- receipt 同时记录受限 log path 与内容 SHA-256；根入口项目文档可以 scoped rebind，legacy `docs/plan/**/{PLAN,SPEC}.md` 的契约变化继续强制失效。
- 所有 ledger mutation 统一持有跨进程写锁，command log 按 execution identity 隔离；transient retry 必须提交与失败尝试不同的状态指纹，`close` 只接受明确终态。
- retry 日志进一步按 attempt 固化；receipt 显式记录 targeted/full validation scope，并在 run 级别限制最多两次 full validation。
- validation scope 进入 stable proof key 与 execution lock identity，避免 targeted/full proof 相互串行或误复用；共享 workflow 与 review loop 同步落地实际 CLI 调用点。
- terminal ledger 在 close 与后续 init 前按 run identity 归档；第三轮 repair 若仍有 blocker 会立即终止，清零则完成。
- repair wave 消费的入站 permit 与该 wave 后续签发的 permit 具有连续但不同的职责；状态机会核对前后 SHA 与来源后允许下一轮授权，同时拒绝同一 wave 重复签发。
- review proof 改为严格 output schema 与流式 JSONL/stderr 监督；长进程只持有 proof identity lock，全局 ledger lock 仅覆盖短 mutation。
- convergence clear 不再提前关闭顶层 flow run；dirty validation 仍按失败尝试消费预算，run id archive 不可复用或覆盖，docs-only attestation 可复用同 profile/base 的 review evidence。
- review timeout 只由有效 JSONL progress 推进，持续 stderr/非 JSON 噪声不能绕过 300/900 秒门禁；helper 在中断时终止独立进程组。
- failed/timeout review attempts 进入 durable ledger：startup 前只允许一次 restart，观察到 `thread.started` 后失败则禁止自动重启；focused replay 只接受 canonical helper launch。
- launcher exception 与 owner interrupt 同样持久化；owner stop 保持显式可重启。输出管道 EOF 不再绕过存活子进程 deadline，无效 review attempt 不可提升为 attestation。
- process-group cleanup 不再依赖 leader 存活，继承管道的 descendant 会在 timeout 后终止；连续 docs-only attestation 扁平回指原始 passed proof，避免第二次文档 delta 重跑 proof。
- review launcher 使用 helper-owned 固定 structured-review prompt 的通用 `codex exec`，因为 `review --base` 子命令不允许同时提供 prompt，且其 skill prose 终态无法满足严格 output schema；base SHA、read-only/no-approval、JSONL 与 structured result 门禁保持不变。
- convergence 的 blocking fingerprint multiset 使用显式计数包含判定，保持 duplicate blocker 严格递减语义并兼容不支持 `Counter` 富比较的 Python 运行时。
- close 会检查 held execution identity lock；retry 只接受 helper 分类的 transient exit；review stall 只由已知 Codex event 刷新，CLI runtime/subprocess/OS failure 使用 JSON error object。
- validation attestation 以显式 input path patterns 检查 delta 相交，且每次 attestation 重新核对 current base；`init` 同时验证 current clean HEAD，避免 stale ledger 与过期 merge proof。
- normalized input paths 纳入 validation proof identity，review 同步核对 ledger base；terminal convergence 与 proof execution 串行，argparse 失败保持 JSON contract，review replay 拒绝 helper 前后拼接任意 shell wrapper。
- malformed ledger JSON 与其他可预期 CLI failure 一样返回 JSON error object，不暴露 traceback。

## Key Reasons / Replacements

- context compaction、输出截断和纯文档提交不应导致相同输入上的重复工作。
- GitHub current-SHA 门禁继续保持严格；receipt 只复用本地等价输入证明。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
