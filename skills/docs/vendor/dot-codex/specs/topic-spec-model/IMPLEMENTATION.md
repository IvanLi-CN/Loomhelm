# 主题级 Spec 模型与历史 specs hygiene 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 让 `docs/specs/**` 回归主题级规格，并补齐历史 hygiene / workflow / migrate 约束
- Current rollout focus: companion-doc 模型已落地，现有 `.codex` specs 已补 `IMPLEMENTATION.md` / `HISTORY.md`，README 也已恢复轻量 implementation 摘要。

## Historical rollout snapshot

- No pre-companion rollout snapshot was recorded for this spec.
- Current lifecycle: active
- Catalog note: 让 `docs/specs/**` 回归主题级规格，并补齐历史 hygiene / workflow / migrate 约束

## Delivery Milestones

- [x] topic-level `SPEC.md` 与 `spec_disposition` 模型已建立
- [x] `spec-sync` / workflow 契约已切到 companion-doc 模型
- [x] 现有 `.codex` specs 已完成一轮 companion-doc backfill
- [x] `docs-migrate MODE=specs-hygiene` 已改为“迁移细节”，不再默认删除细节
- [x] legacy `PLAN.md` sync 与 `MODE=specs` bootstrap 已补齐 companion-doc 边界，不会让 legacy-plan-only 仓库被误判 drift
- [x] 历史 `SPEC.md`-only canonical spec 目录保留读取兼容；只有已出现 companion docs 的目录才要求三件套完整
- [x] 新建 Spec 与 assets/metadata 已切至 slug-only；historical ID-prefixed Spec 继续只读兼容，hygiene 迁移需要显式 rename/delete confirmation
- [x] Spec drift 的 legacy ID 去前缀已与 docs-migrate 的 proof 规则对齐：必须有历史 catalog 的精确 `ID + source path` 或同一 diff Git rename
- [x] docs-migrate guard 仅接受 lowercase kebab-case canonical topics；无法直接作为 slug 的 legacy 目录必须由调用方通过 `--topic` 明确命名
- [x] legacy ID proof 支持从可达 catalog 历史读取相对路径、inline-code 与 Markdown-link 形式，避免已切换 lifecycle catalog 后失去历史目录规范化能力
- [x] 新 Spec 模板以 `## Related ADRs` 索引当前 ADR；`spec-sync` 保留既有 tri-state 输出，同时验证该 section 的路径、排序、去重和 ADR 状态。
- [x] Canonical `Related ADRs` empty state is enforced as a bare `None` line across the Spec checker, drift detector, and Initiative ADR guard; readable legacy paths retain their historical `- None` compatibility marker.

## Rollout Artifacts

### Docs touched

- `AGENTS.md`
- `docs/README.md`
- `docs/specs/README.md`
- `skills/topic-spec/**`
- Canonical invocation is `$topic-spec`; no legacy Skill alias is installed.
- `skills/spec-sync/**`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/docs-migrate/**`
- `docs/specs/topic-spec-model/**`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `b39a914` docs(specs): adopt topic-level spec model
- `b21cbfe` feat(skills): add solution sync and spec sync
- `6ecce09` fix(spec-sync): honor legacy spec refs
- `1ce2aff` fix(review): block incomplete associated specs

## Remaining Gaps

- 个别历史 spec 的 `HISTORY.md` 仍可能只先保留 commit trace；后续若主题演进继续复杂化，应补更细的人工摘要。

## Contract Checker Coverage

- `bin/spec_contract_check.py` is the strict gate for new or modified canonical `SPEC.md` files.
- Companion docs own implementation status, verification commands, rollout facts, and PR/change associations; untouched legacy Specs remain readable.

## References

- `./SPEC.md`
- `./HISTORY.md`
