# PR convergence batching 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

Review-permit and receipt details below are historical rollout snapshots. Current direct flow uses the Formal Review Wave, finding disposition, and Repair Batch contract described in the active specification.

## Current Status

- Late PR resolution applies when a concrete deferral is considered after validation and a complete review/CI round. Eligible PR-introduced P0/P1 remain current-PR priorities; other qualified findings can carry explicit authorized deferrals. After source merge/closeout, one independent fast-flow follow-up reaches Step 5C Ready with separate evidence and count, source traceability and duplicate-safe continuation.

- The shared review-proof reference presents execution in order: readiness, parallel launch, complete-round wait, disposition, pre-write batch accounting, and final-candidate refresh. It explains partial returns from native batch-wait next to the all-terminal rule; live-reviewer uniqueness is explicitly per Candidate and lane. CI tracking, fresh-reviewer requirements, cumulative limits, and delta-based refresh retain their existing owners and semantics.
- The shared review-proof reference now applies a priority-aware repair threshold: an initial Formal Review Wave may optionally repair a P2-only finding; later P2 repair requires a P0/P1 or qualifying current-Candidate CI trigger. P2/P3-only results can clear with `repair_not_required_low_priority` and a next-stop owner report.
- The shared workflow owns candidate freeze/result placement; review-proof owns readiness and cumulative CI/review repair accounting; PR diagnosis owns freshness admission. Entry skills route to these owners, and the optional receipt reference owns ledger behavior only.
- Architecture checks cover operative rule relationships and permit concise rewording; native tool-call replay rejects new formal review or CI tracking during actual conflicts while allowing ordinary target drift. These are offline checks, not live write interception.
- Implementation: 已实现
- Lifecycle: active
- Catalog note: runtime-created fresh review 按 SHA 提供 proof，main-agent 批量收敛，checks 缺席快速诊断
- Current convergence: Formal Review Wave 是固定 base/head 上 review 与 CI 从启动到全部终态的区间；父流程随后分类 findings、处理累计主干变化并执行必要修复。只有 In-Scope Review Finding 进入 Repair Batch，Design-Returning 停止普通收敛，Observation 只报告。父流程保留累计修复计数；接近三批或根因反复出现时先诊断，再自主继续范围内修复，子调用不嵌套修复循环。
- CI tracker 现在以启动时刻为起点保留 `600 seconds (10 minutes)` 的 bounded wait/polling budget；确定性 contract tests 同时守住 bound SHA、一次 retry、terminal state 与 recovery-card 语义。
- Formal Review Wave starts after Review Readiness with fresh runtime reviewers. Delta-proven local repairs retain unaffected results; shared-contract, unknown, high-risk, or actual review-base adoption refreshes all lanes. Observed target advancement follows the diagnosis round-boundary rule.
- Direct PR timing is now explicit: `Step 4 Ready` records readiness and applicable pre-PR proof without completed PR-stage findings; exact live PR base/head binding starts CI tracking and fresh PR-stage formal review in the same first round, and main-agent convergence waits for both terminal states. Local-merge still completes formal review before Step 5L.
- Replay coverage binds the same Candidate to its lane, scope, review profile, locked flow, ownership promise, and cumulative Repair Batch count; mismatches fail closed instead of resetting the repair count.
- The active Spec checker enforces the same disposition, `unchecked` evidence, and complete continuation-anchor contract used by PR convergence.
- Retired disposition terms are regression-tested as failures for this active Spec as well as the other review Specs.
- Repair replay exercises autonomous fourth and later batches and preserves the active Candidate anchor and cumulative count across continuation.
- Migration replay distinguishes accepted baseline limits, candidate regressions, unknown attribution, new guarantees and failed acceptance; recurring roots and a third repair require diagnosis before the replay writes.
- Instruction architecture checks cover the shared disposition contract, all direct-flow consumers, and the review anchor boundaries.
- The first-round PR barrier replay fixture and focused architecture test cover the active consumer contract, active quoted legacy Step 4 serial-gate rejection, long-fence/indented-code/thematic-break/lazy-quote non-operative required-text rejection, four-space and mixed-tab lazy quote continuation, invalid backtick fence info strings, inline-code contract text, tab-indented fence markers, quote block boundaries after headings and HTML blocks, inline HTML and quote-marker-after-tab paragraphs, quote markers inside top-level fences, and historical snapshot wording without false-positive findings. The replay fixture now feeds these parser cases directly into the focused test, including thematic-break marker families, leading/inner spacing variants, quote-prefixed fence boundaries, explicit thematic-break blockquote closure, explicit and unprefixed quote-fence boundary handling with top-level fence reopening, blank-quote closure, unclosed-fence forbidden-gate scanning. The focused test requires the fixture's parser case names to be unique and complete. Inline code remains operative because canonical stage and field names use that form; only fenced, indented, quoted, or historical text is non-operative. The fixture declares `evidence_role=historical-scenario` and keeps its original PR/base/branch under `historical_binding`; it carries no current candidate digest. Its test validates historical provenance without resolving those refs against the current checkout. Branch switches, detached HEAD, dirty candidate edits, and base advancement therefore do not require fixture-refresh commits. Live PR open/base/head and runtime Git-top-level evidence remain adapter/flow responsibilities. Isolated repository tests retain canonical GitHub remote parsing and digest safeguards for content, entry mode, index-hidden edits, symlinked parent directories, traversal stability, and clean state. Required contract checks use operative text only; forbidden serial-gate scans retain active quoted text and malformed unclosed-fence content so legacy wording cannot bypass detection.
- Isolated-copy architecture checks cover readiness language and the active `0017` ADR relationship.
- Direct plan semantic checks reject tier/strategy/profile contradictions, and the replay seam rejects incomplete, scope-forged, or unknown-field structured lane evidence.
- Direct plan semantic checks also require a concrete supported model/effort recommendation and an explicit runtime formal-lane launch/create action; reviewer identity and Repair Batch lane count remain runtime decisions.
- ReviewReplay rejects unknown disposition tokens before deciding whether a candidate may enter a Repair Batch or remain report-only.
- ReviewReplay fail-closes omitted readiness and empty In-Scope evidence before launching or mutating a candidate.
- ReviewReplay also fail-closes unsupported actual profiles and unknown dispositions embedded in structured findings.
- In-Scope repair now requires a demonstrated finding kind, and direct formal policy fields are rejected when duplicated.
- Terminal finding objects must declare a supported demonstrated or observation kind.
- UI entry: 本地可测候选先完成关联基线比较；一致时无需主人回复，有可见变化或不可比较时确认展示截图。无本地证据源仅使用不绑定、不收敛的 feedback-only Draft，直到远端反馈完成同一比较。

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-14
- Legacy last-tracked: 2026-03-14
- Current lifecycle: active
- Catalog note: 风险触发 pre-PR local proof、PR 批量收敛与 checks 缺席快速诊断
- Legacy receipt convergence: validation receipt 绑定 current candidate evidence；每个 epoch 最多三次 repair permit，final merge proof 的 blocker 回到剩余 permit。

## Delivery Milestones

- [x] M1: 建立 `docs/specs/pr-convergence-batching/SPEC.md` 规格并登记索引
- [x] M2: 在 shared Step 4/5 中前置风险触发的 `pre-PR local proof`
- [x] M3: 固化 PR 批量收敛、current-SHA validation evidence 与 checks 缺席诊断门
- [x] M4: 为自动收敛增加 `3` 次 repair permit 止损
- [x] M5: 统一 `CI-Operator` sub-agent 的首选模型为 `gpt-5.6-luna + low`，绑定单一 PR head SHA，将主 agent CI 等待改为阻塞式 barrier，并把共享不变量集中到 CI tracking contract
- [x] M6: review proof 改为按 candidate SHA 的原生只读 task，main-agent 成为唯一写入者
- [x] M7: Spec/Solutions 合并为按需 docs sidecar，仅在有效输入变化时重跑

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `skills/project-engineering-workflow/references/ci-tracking-short-contract.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/project-engineering-workflow/references/review-proof-short-contract.md`
- `bin/flow_receipt.py`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/fast-flow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/ui-visual-evidence/SKILL.md`
- `bin/pr_skill_replay_check.py`
- `docs/specs/mandatory-local-review-proof/SPEC.md`
- `docs/adr/0017-review-readiness-and-runtime-launch.md`
- `bin/instruction_architecture_check.py`
- `bin/test_instruction_architecture_check.py`
- `docs/specs/pr-convergence-batching/replay/first-round-parallel-barrier.json`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `d443ac1` fix(flow): batch PR convergence before remote churn
- `71c44e5` fix(review): preserve convergence budgets across repair pushes
- `f565cff` fix(flow): enforce resumable PR convergence gates
- `281b1cd` fix(flow): honor no-write PR proof gates
- `b4544c8` fix(review): rerun stale pre-pr proofs on new heads
- `3b0afb3` fix(review): bind proof budget to current PR batch
- `90e80dd` fix(docs): persist PR budget bindings consistently
- `2c11073` fix(review): harden proof-only convergence rules
- `4895098` docs(review): add pragmatic stop-loss after repeated reviews
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
