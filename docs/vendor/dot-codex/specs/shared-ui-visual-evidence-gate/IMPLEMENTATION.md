# Shared UI visual evidence gate 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: UI 证据门禁与任务级 PR 图片链路已实现，并由标准库测试与 replay contract check 覆盖。
- Adopted target contract: Phase A 接收 Task Evidence Set 或 `--no-evidence`，生成可见受管 PR `## Visual Evidence` section；Phase B 只从该 section 重绑 merge SHA URL。
- PR body image normalization: Phase A receives explicit Task Evidence Set paths or `--no-evidence`; Phase B strictly parses the one managed PR section and verifies live `bodyHTML`.
- Comparison lifecycle: candidates pair with Git blobs at the same destination path in `FlowLedger.base_sha`; RGBA-safe decoding and heatmaps remain, while current-only or unreadable pairs require confirmation.
- Owner comparison report: `bin/create_reg_cli_report.py` uses explicitly supplied existing chat snapshots as symlinked inputs to one multi-pair `reg-cli` report. Sources may come from any valid repo scope; the output report follows the current repository's repo/date asset layout and canonical slug/hash scope. It records dependency paths and hashes for audit; no input image is copied into a report. Inputs must match the snapshot generator's repo/date/timestamp path layout, be independent regular files, and not resolve through any casing of `reg-cli-reports`. Source hashes are checked after rendering, immediately before publication, and immediately after the final atomic rename; a failed post-rename check removes only the report directory whose inode identity was recorded before publication. Report HTML, JSON, manifest, and diff files must also be independent regular files; audit enforces one link per generated artifact. Audit repeats snapshot-layout and hard-link checks, and detects later content changes, but does not authenticate a coordinated same-UID rewrite of a report and manifest. Creation rejects symlinked report-path components, unsafe report tokens, and replaced staging directories; creation and audit reject misplaced reports, extra snapshot inputs, incomplete HTML entries, symlinked generated outputs, unexpected diff or top-level artifacts, and manifest paths outside the asset root. Audit checks dependency path components before applying `..`, so a symlink-plus-parent traversal cannot normalize away an escape; relative audit paths retain their cwd-relative CLI semantics. Result lists must be unique and partition every pair. Diff artifacts are checked against pinned `reg-cli` `diffItems` semantics, including JPEG-to-PNG diff filenames; owner confirmation still shows the applicable baseline/current images and heatmaps in chat, with HTML as an additional view.
- Sandbox boundary: committed package and lock files pin `reg-cli` and transitive integrity. npm installs with scripts disabled from the official registry in a private staging-local home/cache, with network available only during install; that phase cannot read comparison inputs or source snapshots. The report phase is offline. The Seatbelt profile confines forked renderer workers to the same executable, network, read, and staging-write rules, and inherited custom CA path variables are not passed into the sandbox. It denies file-content reads and directory enumeration under user homes, `/private/tmp`, `/private/var/tmp`, other temp stores, mounted volumes, keychains, and non-runtime third-party tool roots, then reopens exact runtime paths and, only for offline comparison, staging and snapshot paths; metadata needed to resolve allowlisted paths remains readable. After the runner exits, staging is atomically renamed. Validated report, JSON, and diff outputs are APFS copy-on-write cloned into a fresh publication directory outside the runner's writable scope; original input snapshots remain symlinks. The clone set and snapshot hashes are validated before publication, while sandbox hard-link creation to source images remains denied. The sandbox staging is removed. The runner fails closed unless macOS `/usr/bin/sandbox-exec` and filesystem cloning are available. This macOS-only implementation and its tradeoffs are recorded in [ADR 0022](../../adr/0022-sandboxed-reg-cli-report-execution.md).

## Historical Rollout Snapshot

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
- [x] M5: 增加 owner-facing Chat Markdown/HTML 图片 Stop hook 与 replay/单元测试
- [x] M6: 在 Chat 视觉证据与 PR 证据复用规则中明确“同资产集、不同 Markdown URL”
- [x] M7: 实现任务级 PR gate、同路径比较器、touched-file 文档迁移器与 PostToolUse hook

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
- `skills/topic-spec/SKILL.md`
- `skills/topic-spec/templates/SPEC.md`
- `skills/topic-spec/templates/legacy/PLAN.md`（legacy compatibility only）
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/project-engineering-workflow/references/pr-merge-procedure.md`
- `skills/ui-visual-evidence/SKILL.md`
- `skills/ui-visual-evidence/scripts/pr_body_image_gate.py`
- `skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py`
- `skills/ui-visual-evidence/replay/cases.json`
- `skills/README.md`
- `docs/specs/README.md`
- `bin/visual_evidence_replay_check.py`
- `docs/specs/pr-skill-diagnosis-thinning/replay/*`
- `bin/pr_body_image_contract_check.py`
- `docs/specs/shared-ui-visual-evidence-gate/replay/*`
- `bin/owner_facing_image_gate.py`
- `bin/test_owner_facing_image_gate.py`
- `docs/specs/local-chat-image-snapshots/replay/cases.json`
- `hooks.json`

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
- Current policy update: allow page-level Storybook fallback to report Storybook evidence sources only when no qualified `ui_demo` exists and an existing explicit page-level exception authorizes it
- Current policy update: owner-explicit non-Storybook evidence sources stay locked; Storybook cannot masquerade as a satisfied `web demo` / `ui_demo` requirement
- Current policy update: full-page/page-flow Storybook fallback requires both an explicit “no qualified `ui_demo`” outcome and an existing explicit page-level exception, not just Storybook availability
- Current policy update: focused replay coverage now guards owner-locked non-Storybook replacement, full-page Storybook chosen before `ui_demo` availability is resolved, and full-page fallback without an explicit exception
- Legacy policy update: PR image publishing runs through `pr_body_image_gate.py`, with selectors and `bodyHTML` as its final render gate; selector discovery is replaced by the adopted task-scoped contract.
- Legacy policy update: Phase A binds open-PR image URLs to `headRepository + headRefName`; Phase B binds merged-PR URLs to `baseRepository + mergeCommit.oid` with a bounded `0s` / `10s` / `30s` retry only for recoverable finalization failures
- Accepted target contract: task-scoped PR visual evidence is recorded in ADR 0003 and implemented by the listed helpers and hooks
- Current policy update: owner-facing Chat Markdown/HTML images now require readable immutable snapshot paths; the Stop hook retries one repair and then blocks instead of falling back to remote images
- Current policy update: Chat and PR reuse the same logical visual asset set only, with Chat snapshot paths and PR GitHub URLs kept separate

## Remaining Gaps

- Runtime installation still requires the owner-approved `/hooks` trust activation; until then, the final PR document check remains the hard gate.
- Live GitHub Phase A/Phase B execution requires the normal PR flow credentials and an available open/merged PR.

## Contract Checker Coverage

- `bin/spec_contract_check.py` validates the canonical visual workflow Spec while allowing normative PR/Phase language.
- Current Task Evidence Set membership, PR body selections, and Phase A/B receipts remain runtime facts owned by the existing visual and PR skills.

## References

- `./SPEC.md`
- `./HISTORY.md`
- `../../adr/0003-task-scoped-pr-visual-evidence.md`
