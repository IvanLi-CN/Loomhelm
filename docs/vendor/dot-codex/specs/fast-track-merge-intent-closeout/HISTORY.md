# Fast-track merge intent closeout 演进历史（#r4m7k）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- locked fast-track 的 Step 4/local proof 不再可作为 terminal；replay 只有在缺少当前 epoch 的 live PR/current-head 事实时报告 `FAST_TRACK_STOPPED_BEFORE_PR`，并把后续卡片中的旧、待定、未知/不明/不确定/未确认或否定 head 描述视为未证明并撤销既有 live fact，不改变 CI 实际运行时长或现有无 evidence 重判合同。

- Review proof semantics are aligned with the shared contract: missing, stale, malformed, unavailable, or `unchecked` direct evidence blocks closeout, while valid terminal `clear` evidence is classified by finding disposition rather than by blocker wording alone.

- current-head invalidation 现在保留 “not stale / not unknown / no longer pending” 等肯定确认，只撤销明确的旧、未知、待定或否定 live-binding 事实。

- owner-bound `convergence-reopen` 在当前 PR 的首个受限 repair 提交后一次性桥接到 initial review，避免已授权的同一 P2 修复因 SHA 改变而重复索取意图；bridge 仍要求 live PR current head，并保留原 validation/review budget。

- `ff72d05` fix(flow): align fast-track merge closeout semantics
- `b39a914` docs(specs): adopt topic-level spec model
- Initiative roles refine, rather than weaken, fast-track authority: direct delivery keeps its existing merge semantics; child delivery stops at integration CI and aggregate delivery requires SHA-bound owner approval.
- current worktree: 根据 owner 反馈，明确“合并”与“合并并收尾”不是同一终点：普通“合并/merge PR”是 `merge-only`，完成 PR merge 并删除远端 PR head；只有“合并并收尾/merge and cleanup”才执行本地 cleanup。cleanup 包含删除 PR 工作区，并负责处理已合并 PR head 本地分支等本地收尾对象。
- current worktree: CI tracker 子代理已明确为自执行观察者；`$flow-continue` 对 live handle 继续等待，对 terminal `unavailable|incomplete` handle 只创建一个保留 bound identity/retry history 的新 tracker，不复用 completed card，也不再把缺少嵌套 agent-control API 当作 tracker 不可用。
- current worktree: 根据 owner 反馈，明确 `merge-only` / `merge+cleanup` 一旦进入 shared Step 5 merge path，就默认允许 same-PR、in-scope writable convergence；`merge-ready` 仍只表示停在 `Step 5C Ready`，不会自动携带这层可写收敛授权。
- review follow-up: `合并 PR 并收尾` 与 `merge PR and cleanup` 必须优先归类为 `merge+cleanup`，不能被 `合并 PR` / `merge PR` 子串误归类为 `merge-only`。
- review follow-up: `收工条件=merge+cleanup` / `stop condition=merge+cleanup` 这类流程锚点也必须触发 merge+cleanup 守卫，避免会话停在 `Step 5C Ready` 被误判通过。
- review follow-up: `本地收尾=完成` 只是 assistant 总结，不是 cleanup 证据；replay checker 只接受 `$pr-post-merge-cleanup`、`cleanup_skill_invoked=yes` 或 `cleanup_proof`。
- review follow-up: readiness 文案不能压过显式 `merge+cleanup` 锚点；否定句里的 `$pr-post-merge-cleanup` 名称也不能被算作 cleanup proof。
- review follow-up: `cleanup_proof` 必须有正向值，assistant 侧只有显式 state anchor 能设置 `merge+cleanup` intent，普通选项说明不能设置。
- review follow-up: `准备好合并 PR` 仍是 `merge-ready`；`不会/不调用 $pr-post-merge-cleanup` 是否定 proof；assistant `merge+cleanup` state anchor 不会被同句 proof-status 文案清除。
- review follow-up: `$pr-post-merge-cleanup` 的未来承诺不是 cleanup proof；checker 只接受正向结构化 proof 字段。
- review follow-up: 主工作区基线状态属于 merge scope，不会否定同句正向 `cleanup_proof`。
- review follow-up: 诊断命令或搜索输出中出现 `gh pr merge` / `cleanup_proof` 不能被当作真实 merge 或 cleanup proof；checker 必须把证据绑定到实际 merge 调用与最终可信收尾状态。
- review follow-up: `gh --repo owner/repo pr merge` 是真实 merge 证据；只读 `gh api .../merge` 不是，API merge 只有显式 mutating method 才能满足 merge proof。
- review follow-up: cleanup guard 必须以 merge success 为前提；merge 调用被 GitHub 拒绝时，`merge+cleanup` 不能被误判为已合并但跳过收尾。
- review follow-up: `gh pr merge --help` 不是 merge 证据；用户后续明确切回 `准备好 PR` 时，最新 `merge-ready` stop condition 覆盖之前的 merge/cleanup 意图。
- review follow-up: shell-wrapped `gh pr merge` 是常见 exec 形态，checker 必须先解开 `sh/bash/zsh -c` 再判断 merge 证据。
- review follow-up: shell script 中的 `set -e; cd repo && gh pr merge ...` 也是真实 merge 证据，但只能满足其后的 active intent，不能复用早先 turn 的 merge。
- review follow-up: 同一 shell command 若先诊断再 merge，checker 必须继续扫描后续 segment，不能停在第一个非 mutating `gh`。
- review follow-up: replay 里 `shell` tool 的 command-array 形态也要识别；`准备好合并并收尾` 中 cleanup intent 优先于 ready 子串。
- review follow-up: `cleanup_proof=稍后生成` 仍是 pending 占位；活 proof 未终态时，即使 final closeout 写“PR 已合并”也必须失败。
- review follow-up: `/opt/homebrew/bin/gh pr merge ...` 这类 path-qualified gh 调用按 basename 识别为真实 merge 证据。
- review follow-up: final closeout 中的英文 `Merged pull request` 也算 merge success，不能绕过 cleanup-skipped guard。
- owner correction: 远端 PR head 删除属于 merge scope，不属于“合并并收尾”的本地 cleanup；普通合并也必须验证 `远端分支=不存在`。
- owner correction: 普通合并还必须对齐 Git primary worktree 的 PR target base branch，或明确报告 `主工作区基线更新=阻断/待主人决策`；本地 PR topic branch 与 PR worktree 删除仍只属于 cleanup。
- owner correction: `对齐` 定义为 local base 包含最新 remote base，而不是必须等于 remote；dirty/ahead/diverged primary base 应进入 `待主人决策` 菜单，安全对齐必须在 stash/rebase 后把 dirty/untracked 恢复回工作区。
- review follow-up: fork / protected head 的明确 `远端分支=不适用/阻断` 是合法 merge 结果；`gh api .../git/refs/heads/<branch> -X DELETE` 的 endpoint-before-method 写法也必须识别。
- review follow-up: 成功 `[deleted] <branch>` 输出优先于分支名里的失败词；`不是 fork PR head` 不是远端删除豁免。
- review follow-up: `git push origin --delete <branch>` / `git push origin -d <branch>` 是常见远端 head 删除形态，必须用 token 解析识别。
- review follow-up: `gh api ... -X DELETE` 的 `gh:` / HTTP 4xx/5xx 输出是删除失败，不得当成远端 head 已删除。
- review follow-up: `远端分支=不存在` 必须有工具证据支撑；assistant 自报状态不满足远端 head 删除门禁。
- review follow-up: 工具确认 `remote branch: not found` 是远端 head 已不存在的成功证据，不受通用失败词 veto。
- review follow-up: 删除样式输出必须绑定到已识别的删除或验证命令；无关诊断输出不能满足远端 head 删除门禁。
- review follow-up: `gh pr merge --delete-branch` 的删除失败输出不能算远端 head 删除；已知 `headRefName` 时必须匹配被删除 ref。
- review follow-up: PR head 取自自然语言句子时会去掉句尾标点，再与实际删除输出匹配。
- review follow-up: 组合命令里的远端删除先按 shell segment 解析，避免后续验证命令参数污染被删除分支名。
- review follow-up: 分支特定删除 proof 必须绑定 PR head 证据，并递归解析 shell wrapper 内的组合删除。
- review follow-up: `git push --delete` 分支解析会截断重定向与管道后缀，避免把日志捕获参数当成 ref。
- review follow-up: `git push origin :refs/heads/<branch>` 删除 refspec 会归一为短分支名后再匹配 PR head。
- review follow-up: 多行 shell script 按换行分段，PR head 捕获支持 `+` 等合法 ref 字符。
- owner follow-up: merge-scope base alignment新增专用 helper，先固定解析 Git primary worktree，再只自动执行安全的 tracking-ref / ff-only 更新；dirty、ahead、diverged 等主工作区 base 状态继续保留给主人决策。
- owner follow-up: 在主人明确选择 `安全对齐` 后，base-alignment helper 现在也接管备份分支、`stash -u`、`rebase`、`stash apply` 与冲突恢复态输出，不再依赖临时 shell 拼接。
- compression pass: skill 文案压缩为引用共享 stop-condition contract，减少重复展开但不改变行为。
- owner correction: 本地 Step 4 收口和 live PR `merge-ready` 必须拆词；没有 open PR 时只能称为 `可开 PR（local）`，不得宣告 `Step 5C Ready` 或 `latest PR 可立即合并`。
- owner correction: merge / cleanup 不是所有 run 的最终语义；若 release / deploy / publish / post-merge workflow 仍未终态，shared flow 必须继续进入 `Step 6 post-merge finality follow-up`，优先 app automation，CLI 再回退 repo-native watcher，并统一使用 `gpt-5.6-luna + xhigh`。
- review follow-up: `merge+cleanup` 只有在拿到正向 `cleanup_proof` 后，`Step 6` 未决时才能恢复到 `$pr-merge`；`blocked|pending|unchecked` 等非正向值仍必须继续 `$git-cleanup`。
- review follow-up: `flow_continue_replay_check.py` 与 `r4m7k` replay fixtures 现在同时覆盖“cleanup 已完成再回 Step 6”和“cleanup proof 非正向时不得跳过 cleanup”两条恢复路径。
- owner follow-up: 根据成本约束，Step 6 改为只追踪 merge SHA 在目标分支触发的 CI；PR head 与 merge SHA 各使用一个 `gpt-5.6-luna + low` sub-agent，主 agent 通过阻塞式 `wait_agent` 等待，计划任务不再作为主动路径；共享不变量集中在 CI tracking short contract，入口 skill 只保留 phase/identity 与编排职责。
- owner correction: target-branch CI 不是完整 post-merge 终态。`Release Snapshot` 只证明发布意图；当仓库合同与 merge-SHA live facts 表明预期发版时，流程必须继续等待实际 Release/package/container 终态，并在最终回复明确报告版本等核心发布信息。发布跟踪使用独立 short contract，30 分钟未终态仍视为流程未完成，失败仅在可证明幂等时重跑一次。
- review follow-up: release replay 现在拦截完全漏报、expectation/status 矛盾、实际 tag/SHA 错绑与 timeout 缺恢复锚点，并接受仓库合同声明的 package/container-only 发布证据。
- review follow-up: release evidence 进一步绑定当前 expectation/repository epoch，区分 draft creation 与 actual publication，要求实际 artifact SHA，并对未发版证据与幂等单次 rerun 进行可回放校验。
- review follow-up: harden tracker replay evidence so real `wait_agent` tool calls, concrete SHA bindings, and historical automation compatibility are distinguished correctly
- review follow-up: bind tracker launch, wait, and SHA evidence to one instance, include automatic topic-branch push checks, and ignore unrelated automation pause/archive calls
- review follow-up: bind replay evidence to the launched agent identity and bound SHA, and make `defer` terminal through its explicit infra-blocked record rather than a nonexistent tracker
- review follow-up: support real collaboration spawn output and implicit wait schemas, retain matched barrier evidence across later waits, and enforce phase identity in replay cards
- review follow-up: require a tracker status card, prefer concrete spawned-agent identities, and scope legacy scheduled evidence to the active follow-up mode
- review follow-up: accept PR-head result cards, validate completed wait outputs, and use checked SHA when collaboration arguments hide the encrypted tracker prompt

## Legacy Change Log

- review follow-up: require terminal result/disposition fields for post-merge cards and retain pre-status scheduled-launch candidates for legacy-route detection
- review follow-up: limit phase inference to structured tracker inputs, enforce post-merge-only fields, and ignore negated automation prose
- review follow-up: bind retry authorization to an observed failure for the tracked run and prevent batched or cross-epoch facts from contaminating release state
- review follow-up: reject stale publication facts with a conflicting release epoch and recognize GitHub Enterprise release paths
- review follow-up: normalize string-encoded and text-wrapped tool output before applying the release discovery contract
- review follow-up: merge split discovery blocks and require complete publication coverage for all declared release identities
- review follow-up: reject conflicting artifact identity, accumulate immutable same-epoch run IDs, and preserve split-block scalar conflicts
- review follow-up: reject cross-repository release reruns without treating equivalent short/full SHA or tag forms as conflicts
- review follow-up: bind pre-discovery target-CI rerun authorization to the repository as well as the run ID
- review follow-up: distinguish PR-head CI reruns and support non-GHCR packages plus version-tagged container aliases
- review follow-up: bind release decisions to the target branch and support immediate incomplete recovery when no tracker is available
- review follow-up: count compound release reruns per command segment and accept standard MCP structured-content wrappers
- review follow-up: same-epoch heartbeat cards cannot rebind repository/branch/SHA/tag, and unresolved `gh run rerun` targets are rejected as unsafe
- review follow-up: snapshots and candidate package metadata cannot prove publication, reruns require a fresh terminal fact, and failure closeout names its surface and disposition
- review follow-up: release applicability follows trusted release context and remote-merge identity rather than a generic merge phrase, preserving valid local-closeout semantics
- review follow-up: failed `gh pr merge` attempts never establish remote release context; only matching success output does
- review follow-up: expected/unresolved non-success closeout retains explicit owner fields, while `success=false` is distinct from `published=false` for retry evidence
- review follow-up: structured remote merge success cannot use release-not-applicable, and target repository identity may come from a bound Actions workflow URL
- review follow-up: direct `release_expected`/`release_enabled` conflicts are rejected, and unrelated Actions URLs do not initialize release-run identity
- review follow-up: normalize all remote merge success result spellings into the release gate, and require complete terminal reporting fields for both published and untriggered release outcomes

- current worktree: Step 5C now uses a runtime decision card derived from target-repository policy and current PR facts; merge-only and merge+cleanup require explicit owner confirmation including the version expectation, while post-merge release facts bind to target repository, branch, and merge SHA. New plan syntax adds no release arrangement fields or final version.
- owner correction: Step 5C confirmation is a single natural-language interaction. A clear message may confirm the card, state the version expectation, and request merge together; the Agent must not prescribe a reply template or split the action into a second turn.

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#r4m7k`.

- Added ADR 0019 and the pre-merge `release_disposition` route gate; target repositories retain ownership of release vocabulary and managed labels.

- Superseded the plan route gate with ADR 0021: pre-merge route resolution is runtime-derived, and an absent route becomes `no-managed-route` without blocking PR publication.
