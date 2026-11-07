# CVM imagegen fallback skill 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 显式 CLI fallback，固定走 `CVM_API_KEY` 与 `https://vibe-code.ivanli.cc/v1`

## Coverage / rollout summary

- 已新增 `skills/cvm-imagegen/` 独立 skill 目录。
- 已新增 wrapper CLI，并复用系统 imagegen fallback 的命令接口。
- 同步 client 包含按 `images.edit` 签名工作的兼容层：旧版 SDK 将未声明的输出格式、压缩和输入保真字段编码至 `extra_body`，不会将未声明的 `moderation` 编码为 provider 扩展字段。
- 回归测试根据运行时 `images.edit` 签名判断已声明的 `moderation` 是否应出现在 multipart 中，保持旧版与新版 SDK 的覆盖一致。
- wrapper 将有效透明背景请求传给 CVM，而不复用系统 fallback 对单个模型的过时本地能力拒绝；同步、异步 Images API HTTP 4xx/5xx 均标记为 CVM backend rejection。
- 带参考图的 `generate` 复用系统 `edit` 路径，将上传图片保留到 sub2api 的编辑请求；普通文本生成仍走生成请求。
- GPT Image 2 系列型号复用弹性尺寸校验；回归测试覆盖参考图路由、默认输入保真行为和型号尺寸。
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
