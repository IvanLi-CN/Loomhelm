# CVM imagegen fallback skill 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 显式 CLI fallback，固定走 `CVM_API_KEY` 与 `https://vibe-code.ivanli.cc/v1`

## Coverage / rollout summary

- 已新增 `skills/cvm-imagegen/` 独立 skill 目录。
- 已新增 wrapper CLI，并复用系统 imagegen fallback 的命令接口。
- 已补最小参考文档集合：CLI 用法与 API 参数说明。
- 已更新 `skills/README.md`，让新 skill 可发现。

## Remaining Gaps

- 若系统 imagegen fallback 将来重构内部 helper 名称，wrapper 需要同步维护 patch 点。

## Related Changes

- `skills/cvm-imagegen/SKILL.md`
- `skills/cvm-imagegen/scripts/image_gen.py`
- `skills/cvm-imagegen/references/cli.md`
- `skills/cvm-imagegen/references/image-api.md`
- `skills/README.md`

## References

- `./SPEC.md`
- `./HISTORY.md`
