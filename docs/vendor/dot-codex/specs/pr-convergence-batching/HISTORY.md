# PR convergence batching 演进历史（#syj6s）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- Review rounds are defined as bound review/CI execution, with disposition and repair outside. The parent owns one cumulative three-batch repair budget; child reviewers do not nest independent loops, and the third repair still receives verification. Ordinary mainline advancement is batched at the round boundary rather than restarting live work.
- Historical first-round parser replay is now explicitly separated from live candidate proof. Its original PR/base/branch remain provenance; the test no longer compares them or a tracked whole-tree digest to the mutable checkout. Isolated digest safeguards and runtime candidate evidence remain in place.
- Evidence result placement is separated from tracked contract updates to avoid candidate-SHA refresh loops. The workflow owns placement, review-proof owns cumulative repair accounting, and diagnosis owns freshness; duplicated entry prose was folded into these owners, with concise-rewording coverage replacing full-sentence checks.
- UI 在可本地验证时先完成证据展示与关联基线比较，再冻结 candidate 进入 PR 收敛；一致时无需主人回复，有变化或不可比较时确认展示截图。无本地证据源的 Draft 被收窄为 feedback-only 状态，远端反馈比较完成前不绑定 receipt 或启动 CI/review/merge。

- shared convergence 不再调用独立 review/fix loop；每个 candidate SHA 创建一个窄上下文 native review task，`main-agent` 负责所有写入和一轮一次 push。
- formal review now waits for Review Readiness and creates fresh runtime reviewers; plans no longer predeclare lanes or model identities, and Repair Batches use provable delta refresh with conservative full-refresh triggers.
- The PR path now has an explicit stage boundary: `Step 4 Ready` records readiness and applicable pre-PR proof without completed PR-stage findings; exact live PR base/head binding starts CI tracking and fresh PR-stage formal review in the same first round, and main-agent convergence waits for both terminal states. Local-merge formal review remains before Step 5L.
- The first-round barrier now has a replay fixture and focused false-positive protection: required phrases come from active operative prose, active quoted legacy serial-gate wording is rejected, long/indented/lazy non-operative text cannot satisfy required phrases, and historical snapshot wording is ignored.
- Follow-up parser hardening now treats thematic breaks as the end of lazy blockquote continuation and keeps quote markers inside top-level fenced code literal; focused regressions cover both boundaries.
- The follow-up replay fixture now owns the parser boundary cases, including all thematic-break marker families, so focused tests fail closed when a parser case is removed from the fixture or implementation.
- The next follow-up hardening requires quote-prefixed fence content to remain quote-prefixed, routes required-contract checks through operative text, and binds replay evidence to the current candidate's repository/base/head facts.
- The following parser hardening closes blank and explicit thematic-break blockquotes, handles explicit and unprefixed quote-fence boundaries with top-level fence reopening, surfaces unclosed-fence text to forbidden-gate scans, rejects non-canonical GitHub remotes, and binds the follow-up replay to repository identity, a resolvable base ref/SHA, a fixed head ref with runtime exact head SHA, actual tracked worktree content/mode, and an immutable clean-Git-tree digest including entry modes with length framing that normalizes only its own field.
- The next parser hardening aligns fence and blockquote indentation with CommonMark, rejects backticks in backtick fence info strings, keeps four-space lazy quote continuations quoted, and rejects intermediate directory symlinks while binding the candidate worktree.
- The follow-up binding hardening uses CommonMark tab-stop indentation for mixed-space/tab lazy continuations, checks entry stability and clean state before and after the digest walk, and locks the replay fixture to a unique complete parser-case name set.
- The active-text contract explicitly keeps inline-code stage and field names operative while continuing to exclude fenced, indented, quoted, and historical text.
- The final replay hardening tracks whether an active block is a paragraph before accepting lazy quote continuation, covers heading/HTML boundaries, and rechecks the fixed head ref and `HEAD` around digest traversal; `repo_root` remains portable runtime Git-top-level evidence.
- The replay binding now pins its PR locator and keeps exact `head_sha` as runtime PR/formal evidence (avoiding a self-referential tracked field), while the parser distinguishes block HTML from inline tags and consumes a tab after a quote marker as paragraph indentation.
- After the follow-up parser PR was merged into its parent, the replay fixture and focused binding test were rebound to the parent PR and current main base before the parent convergence review.
- The parser review then closed an HTML block lazy-continuation bypass by distinguishing block HTML starts from inline HTML and adding a dedicated unprefixed boundary fixture.
- The parser follow-up now recognizes standalone arbitrary HTML tags and excludes multiline comments, `script`, and `style` blocks from operative contract text while retaining them for forbidden serial-gate scanning.
- Tier-consistent direct-plan guidance, complete readiness vocabulary, and clear structured lane evidence are now enforced before convergence can clear; scope mismatches, unknown fields, and unchanged base-drift bindings fail closed.
- Direct-plan gates now fail closed for strategy text that merely co-occurs readiness/runtime terms or profile text that omits a concrete model/effort pair.
- Malformed review dispositions now fail closed rather than being inferred as report-only or in-scope repair evidence.
- Omitted readiness and empty In-Scope evidence now fail closed at the replay boundary.
- Terminal replay evidence now rejects unsupported actual profiles and unknown embedded finding dispositions.
- Observation-only terminal evidence cannot authorize an In-Scope Repair Batch; duplicate formal policy fields are rejected.
- Missing or unknown structured finding kinds are rejected before evidence can become terminal.
- A blocking finding in valid terminal clear evidence follows disposition; only unavailable or malformed output remains `unchecked`.
- CI/review 按 SHA 短生命周期，Spec/Solutions 使用按需 docs sidecar；新 SHA 重建 SHA-bound tracking，但继承同一 PR 的 `3/2` 预算。
- 收敛预算改为一次 initial review 加最多三轮 repair 的单调 fingerprint 合同：无进展只允许一次诊断，之后以 `NON_CONVERGENT` 终止；内层 invocation 不重置预算。
- CI tracker 的 bounded wait/polling budget 统一为从启动计时的 `600 seconds (10 minutes)`；预算调整不改变 bound SHA、一次 transient retry、terminal state 或 recovery-card 语义。
- Review repair eligibility now distinguishes the initial Formal Review Wave from later waves: an initial P2-only repair is optional, later P2 repair needs a P0/P1 or qualifying current-Candidate CI trigger, and low-priority findings may clear with an explicit non-blocking resolution.

- 统一首轮 `CI-Operator` sub-agent 的模型偏好为 `gpt-5.6-luna + low`，绑定单一 PR head SHA，并要求主 agent 通过阻塞式等待接收结果；模型或 effort override 在 child start 前不可用时只可改用不同的完整显式 pair，同时保持 review profile 不变；重复的 tracker 不变量集中到 CI tracking short contract。
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

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#syj6s`.
