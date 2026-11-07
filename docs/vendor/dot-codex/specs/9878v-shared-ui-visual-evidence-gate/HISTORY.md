# Shared UI visual evidence gate 演进历史（#9878v）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `e8d633b` feat(workflow): add ui visual evidence gate
- `43a545f` fix(workflow): unify visual evidence section
- `3ccadcb` fix(workflow): repair visual evidence continuation
- `ce9708d` fix(flow): reroute stale ui evidence
- `47f117b` fix(workflow): harden visual evidence contracts
- `2162cfc` fix(workflow): preserve visual evidence sources
- `eba6468` fix(flow): align screenshot continuation
- `6ccbb70` fix(workflow): finalize visual evidence migration
- `6a086cb` fix(workflow): relax visual evidence reuse
- `afeddc2` fix(workflow): preserve legacy screenshot migration
- `f6e92bb` fix(workflow): close visual evidence gates
- `2d32ba1` fix(workflow): tighten visual evidence convergence
- `9fcf407` fix(workflow): retire stale visual evidence
- `d5a96b3` fix(spec): use absolute validator paths
- `686dbcc` fix(workflow): tighten visual evidence freshness
- `cc02cff` fix(workflow): align evidence helper rules
- `66a17b9` fix(workflow): preserve explicit no-image PRs
- `b4b24bf` fix(workflow): support canvas-only storybook
- `fcc3d87` fix(workflow): route visual gate through step 4b
- `7fcd6fc` fix(workflow): persist pr evidence state
- `5c424ce` fix(workflow): persist step-4b resume state
- `77fb1ed` fix(workflow): tighten visual evidence readiness
- `5f91ac6` fix(workflow): restore screenshot approval guards
- `a20d386` fix(workflow): align step-4b pr gates
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- 2026-03-24: 新建规格，锁定 shared UI visual evidence gate、Storybook 前置门禁与统一视觉证据契约。
- 2026-03-24: 完成 shared workflow、flow skills、Storybook skills、spec 模板与新 `$ui-visual-evidence` skill 的联动更新。
- 2026-03-24: 根据 local-merge proof 反馈补上 `聊天回图` 恢复门禁、PR 证据子集选择器，以及 legacy `PLAN.md` 持久化兼容。
- 2026-03-24: 根据第二轮 local-merge proof 反馈补上“PR 阶段 UI fix 使视觉证据 stale 时必须回 Step 4B 重清”的续推路由。
- 2026-03-24: 根据终版 local-merge proof 把 `PR: include` 收紧为显式白名单，并允许 canvas-only Storybook 仓库在稳定 story 入口下通过 Step 3F。
- 2026-03-24: 根据后续 proof 补上“spec 关联 UI 在 Step 4 必须已落盘”与“新 section 无 PR 标记时仍可回退旧 `## Visual Evidence (PR)`”两条兼容门禁。
- 2026-03-24: 根据续推 proof 补上 `证据落盘` 的恢复门禁，并把 Storybook 截图区分为 local-review-only 与 PR-bound 两种后续动作。
- 2026-03-24: 根据最新 proof 把 `PR: include` 固定为新 section 内的唯一 PR 白名单，并允许选择器与图片之间保留一行说明文字。
- 2026-03-24: 根据收尾 proof 放宽“已提交本地验收图”的 PR 复用路径，并把 legacy fallback 收紧为“仅新 section 为空时兜底”，避免误丢图或误带图。
- 2026-03-24: 根据最终 proof 把 legacy `## Visual Evidence (PR)` 明确收窄为“迁移期 PR 旧源”，禁止 owner-only 图片写回该 block，并要求在没有 `PR: include` 之前继续从 legacy block 兜底 PR 图片。
- 2026-03-24: 根据末轮 proof 补上“非 UI 任务也必须经由 `$ui-visual-evidence` 落 `不适用`”以及“local-merge proof 产新提交后需回 Step 4B 重清视觉证据”的收口约束。
- 2026-03-24: 根据追加 proof 补上“主人拒绝 PR 放图时 legacy fallback 也必须停用”“PR 同回合 fix commit 也要回 Step 4B 重清证据”以及“Step 4B 对非 UI 任务同样是必经清门禁”三条一致性约束。
- 2026-03-25: 根据重试 proof 补上 legacy `PLAN.md` 资产路径修正，并要求历史 `## Visual Evidence (PR)` 在出现新截图后必须同步退役或刷新，避免继续发布旧图。
- 2026-03-25: 根据最新 proof 把 stale 规则收紧为“仅渲染面/输入变更或真正修复提交才使证据失效”，并允许纯证据落盘提交把同一批图片重新绑定到新 `latest_sha`。
- 2026-03-25: 根据最新 proof 补上 `pr-create` 的成功条件约束，要求 `UI-affecting` PR run 在当前 `PR.head.sha` 上仍保持 Step 4B clear 后才能宣告 `Step 5C Ready`。
- 2026-03-25: 根据后续 proof 把 `$ui-visual-evidence` 的 stale 规则与 shared workflow 对齐，并为 legacy `PLAN.md` 明确 `./assets` 资产落盘目录，避免元数据提交误触发重采或 legacy plan 截图路径悬空。
- 2026-03-25: 根据后续 proof 区分“显式无图 PR”与“Spec视觉证据缺失”，要求 PR 路径保留 `PR截图原因=显式无图PR` 的单独语义。
- 2026-03-25: 根据后续 proof 补上高风险 run 在纯证据落盘提交后也要刷新最终 `HEAD` 的 `pre-PR local proof`，避免 Step 4 用过期 proof 收口。
- 2026-03-25: 根据后续 proof 放宽 AGENTS 顶层 Storybook 前置表述以兼容 canvas-only 仓库，并为 `pr-create` 明确 legacy `PLAN.md` 的 PR 截图资产目录。
- 2026-03-25: 根据后续 proof 修正 Step 4 的门禁顺序，明确视觉证据 hard gate 只能在 `Step 4B` 生效，避免在进入 4B 前被 4A 提前阻断。
- 2026-03-25: 根据后续 proof 补上 merge-path 在真正 merge 前也要复核 Step 4B freshness，并要求 PR 阶段停靠时持久化 Step 4B 状态字段供续推恢复。
- 2026-03-25: 根据后续 proof 为 `视觉证据=不适用` 的非 UI spec/plan PR 单独保留 `PR截图原因=视觉证据不适用`，避免误报缺图。
- 2026-05-05: 根据 PR #20 暴露的问题补上 PR body 图片规范化失败态：裸文件名、repo-relative 图片路径或 fenced code block 路径列表不能算有效截图，必须改写成 GitHub blob Markdown image。
- 2026-05-29: 将 Web UI 视觉证据来源改为对象分流：组件/片段继续走 Storybook 前置门禁，完整页面/流程默认走合格 `ui_demo`，缺少 `ui_demo` 时才 fallback 到完整页面级 Storybook。
- 2026-05-29: 同步 `pr-create` 截图 metadata 合同，允许 PR 证据保留 `source_type=ui_demo`，避免完整页面 demo 证据被迫伪装成 `mock_ui`。
- 2026-05-29: 修正 Step 3F 通过条件，允许缺少合格 `ui_demo` 的页面级 Storybook fallback 使用 `storybook_docs` 或 `storybook_canvas` 作为证据目标源。
- 2026-06-21: 根据 thread `019ee3e9-5cef-7b62-9d4d-8a484d03e278` 暴露的偏航，补上“主人显式要求 `web demo` / `ui_demo` 后不得被 Storybook 顶替”的锁定合同，并把整页/流程 Storybook fallback 收紧为“先明确缺少合格 `ui_demo`”后的合法兜底路径。
- 2026-07-20: 根据 PR 图片坏链路复盘，把 `PR: none` 固定为 preferred `## Visual Evidence` section 唯一合法的显式无图语义，并收紧为“有图却无 selector 一律阻断”；自然语言 `Recommended PR subset...` 不再兼容解析。
- 2026-07-20: 新增 `skills/github-pr-body-images/scripts/pr_body_image_gate.py`、单元测试与 contract-check，要求 Phase A / Phase B 都以 helper + GitHub `bodyHTML` 为最终验证面；Phase B 失败只记 `PR图片最终化=失败`，不回滚 merged PR。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#9878v`.
