# Shared UI visual evidence gate 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 为 UI-affecting 工作新增组件/片段 Storybook 前置门禁、`ui_demo` 整页证据分流、本地视觉证据回传/落盘契约，以及 PR 图片 helper 硬门禁
- PR body image normalization: helper-enforced `PR: include` / `PR: none` selectors, GitHub blob rewrite, and live `bodyHTML` verification for repo-relative residue.

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-24
- Legacy last-tracked: 2026-03-24
- Current lifecycle: active
- Catalog note: 为 UI-affecting 工作新增组件/片段 Storybook 前置门禁、`ui_demo` 整页证据分流与本地视觉证据回传/落盘契约

## Delivery Milestones

- [x] M1: 建立 `docs/specs/shared-ui-visual-evidence-gate/SPEC.md` 规格并登记索引
- [x] M2: 为 shared workflow 与 flow skills 增加 Storybook/视觉证据门禁
- [x] M3: 新增 `$ui-visual-evidence` 并升级 Storybook 相关 skill 契约
- [x] M4: 更新 spec 模板、技能索引与 PR 证据晋升规则

## Rollout Artifacts

### Docs touched

- `AGENTS.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/normal-flow/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/storybook-stories/SKILL.md`
- `skills/storybook-stories/agents/openai.yaml`
- `skills/storybook-screenshots/SKILL.md`
- `skills/storybook-screenshots/agents/openai.yaml`
- `skills/ui-visual-evidence/SKILL.md`
- `skills/ui-visual-evidence/agents/openai.yaml`
- `skills/docs-plan/SKILL.md`
- `skills/docs-plan/templates/SPEC.md`
- `skills/docs-plan/templates/PLAN.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
- `skills/github-pr-body-images/SKILL.md`
- `skills/github-pr-body-images/scripts/pr_body_image_gate.py`
- `skills/github-pr-body-images/scripts/test_pr_body_image_gate.py`
- `skills/github-pr-body-images/replay/cases.json`
- `prompts/pr-create.md`
- `skills/README.md`
- `docs/specs/README.md`
- `bin/visual_evidence_replay_check.py`
- `bin/pr_body_image_contract_check.py`
- `docs/specs/shared-ui-visual-evidence-gate/replay/*`

### Plan assets

- Directory: `docs/specs/shared-ui-visual-evidence-gate/assets/`
- In-plan references: None
- Visual evidence source: not used for this docs/skill change

### Asset promotion

None

## Related Changes

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
- Current policy update: route full-page visual evidence through `ui_demo`
- Current policy update: allow PR screenshot metadata to preserve `source_type=ui_demo`
- Current policy update: allow page-level Storybook fallback to report Storybook evidence sources when no qualified `ui_demo` exists
- Current policy update: owner-explicit non-Storybook evidence sources stay locked; Storybook cannot masquerade as a satisfied `web demo` / `ui_demo` requirement
- Current policy update: full-page/page-flow Storybook fallback requires an explicit “no qualified `ui_demo`” outcome, not just Storybook availability
- Current policy update: focused replay coverage now guards both “owner-locked non-Storybook source replaced by Storybook” and “full page Storybook chosen before `ui_demo` availability is resolved”
- Current policy update: PR image publishing now runs only through `pr_body_image_gate.py`, with `PR: none` as the sole explicit no-image marker and `bodyHTML` as the final render gate

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
