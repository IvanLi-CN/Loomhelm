# 规格（Spec）总览

本目录是 topic-level specification catalog：每个 spec 对应一个稳定主题、能力、接口或约束的长期契约，不是单次任务的进度卡片。

每个新 spec 目录默认包含：

- `SPEC.md`：当前有效规范 / 主题契约；`## Related ADRs` 列出当前关联 ADR，或写 `None`
- `IMPLEMENTATION.md`：实现覆盖、当前状态、剩余缺口与 rollout 事实
- `HISTORY.md`：主题局部生命周期、替换、兼容性与必要背景；不复制 ADR 的完整取舍理由

## 新建 Spec

1. 选择唯一、稳定的 kebab-case topic slug。
2. 新建 `docs/specs/<topic>/`。
3. 创建 `SPEC.md`、`IMPLEMENTATION.md` 与 `HISTORY.md`。
   - `SPEC.md` 的 `## Related ADRs` 按路径升序列出当前关联 ADR 的 Markdown 链接；无关联时写 `None`。
4. 在下方 Index 表尾追加一行，默认 `Lifecycle=active`、`Successor=-`。

新 spec 不使用 ID。历史 `docs/specs/<legacy-id>-<topic>/` 与 `docs/plan/**/PLAN.md` 仅保留读取兼容，规范化由 `$docs-migrate MODE=specs-hygiene` 在确认后完成。

## Lifecycle

- `active`：当前主题 spec 是有效真相源。
- `superseded`：已被 `Successor` 指向的 topic spec 取代。
- `archived`：仅保留历史参考，不再作为当前规范输入。

`Implementation` 只放轻量摘要；详细状态、rollout 与剩余缺口必须写入同目录 `IMPLEMENTATION.md`。

## Index

| Topic | Lifecycle | Implementation | Spec | Successor | Notes |
| - | - | - | - | - | - |
| 示例稳定主题 | active | 部分完成 (1/3) | `example-topic/SPEC.md` | - | 记录这个主题覆盖的长期边界 |
