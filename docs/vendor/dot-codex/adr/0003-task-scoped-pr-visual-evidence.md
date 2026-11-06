---
status: accepted
---

# PR 视觉证据采用任务级选择

长期 `SPEC.md` / `PLAN.md` 的 `## Visual Evidence` 是主人验收与主题历史的归档，不是当前 PR 的选图数据库。Phase A 必须接收当前 UI 任务显式声明的 repo-relative Task Evidence Set，或显式 `--no-evidence`；它据此生成 PR 正文可见的受管 `## Visual Evidence` section。Phase B 只读取这个 section 并把现有 URL 重绑到 merge SHA，绝不重新扫描关联 Spec、Plan 或历史图片。

视觉比较也以任务路径为身份：候选图片只与锁定 base commit 中相同 repo-relative path 的 blob 比较。路径在 base 中不存在时结果是 current-only，不按 Spec 中的图片顺序、不按相似度，也不从其他历史图片寻找替代基线。

已退役的 PR selector markup 只在当前任务已经修改关联文档时做安全迁移。PostToolUse hook 提供即时归一化和反馈，最终 PR 门禁复查相同规则；含有并存图片 section 等歧义时必须保留文件并要求人工决定，不能自动合并或删除证据。

## Considered Options

- 在每个 Spec 内引入永久 Evidence Surface 分组：会把一次任务的临时选择固化为文档结构，并增加分裂与重复归档风险。
- 继续扫描 Spec 的 selector：历史归档会随时间扩大，无法证明被选图片属于当前 PR。
- 在 PR 正文写隐藏元数据清单：会制造第二个不可见事实源，且不能让审阅者直接核对选择结果。

## Consequences

- PR 选图输入变成显式、可审计且与当前任务绑定；同一张历史图片只有在被当前任务明确传入时才会发布。
- 可见受管 PR section 是 Phase B 的唯一持久选择记录，仍保留人工可读性。
- 每轮迁移只触及已改文档，避免为了清理旧 markup 制造大规模文档 churn；歧义旧文档会暂时阻断相关 PR，直到有人作出合并决定。
