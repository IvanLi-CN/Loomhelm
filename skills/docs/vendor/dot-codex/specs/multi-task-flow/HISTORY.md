# Multi-task Flow History

## Lifecycle / Compatibility

- Dashboard 浏览器路由统一为当前宿主内置能力优先，补齐 ChatGPT Desktop 场景及通用 ego-browser 偏好的专用例外；无需账本迁移或 viewer 升级。

- 依赖图布局集成保留卡片资源浮层交互；合成示例的对话按钮只提供详情，不提供原生会话跳转。

- 卡片普通悬浮预览不再重复对话正文，改为280px紧凑任务信息；对话、PR、时间保留独立触发区。消息时间为可选只读投影，既有账本无需迁移。交付单元详情及预览不再借用贡献任务用时；浏览器 PR 状态增加请求／观察顺序保护，关闭普通预览后残留动画帧不再重新显示它。

- 2026-11-05: Added the execution-profile contract: one run default, independent delivery-unit/task overrides, complete model-plus-thinking pairs, pre-creation editing with claim replacement, and CLI-owned conversation creation. Runtime changes made inside an existing conversation remain outside the orchestration ledger.

- This topic introduces a separate coordinator and leaves existing legacy coordination sessions and contracts in place.
- The dashboard service wrapper now owns its PID and service-lease lifecycle, while host-native background-session creation and retention remain outside the Skill boundary.
- Lease heartbeats now separate the PID being recorded from the expected owner guard, preserving first PID binding while preventing same-name replacement leases from being changed by an old wrapper.
- Startup registration now claims the inspected lease state under the registry lock before writing the wrapper PID, preventing an inspect/register race from overwriting a replacement lease.
- The wrapper now completes that guarded claim before binding its HTTP listener, so a rejected claim never briefly occupies the preview port.
- The wrapper now holds the registry lock through listener binding and rejects duplicate startup, so an active owner cannot be overwritten and a startup PID cannot be GC-collected before the listener is ready.
- Startup cleanup now retains the listener handle before post-bind verification or lease persistence, so those failures stop the just-started dashboard instead of leaving an unmanaged listener.

- PR #234 aligns medium responsive card/board tracks, fixes absolute inspector width bounds, combines section headings with layout controls, adds layout tooltips, and stops serializing graph zoom in generated URLs.

- ADR 0042 supersedes ADR 0036 to retain the existing dashboard decisions while adopting the owner-approved stable outer tracks, absolute inspector bounds and interaction-local graph zoom.

## References

- PR #252 增加仅用于新 run 的首个主对话 bootstrap 交付单元；后续 regular 单元仍归独立 group 会话。既有单元的类型和 owner 不支持原地迁移，历史账本保持兼容读取。

- `./SPEC.md`
- `./IMPLEMENTATION.md`

## Shared user viewer

Accepted the per-user, on-demand singleton design in ADR 0042. The implementation adds shared paths and contracts, lease-driven launchd lifecycle, authenticated multi-run routes, explicit release maintenance and exact-source import recovery. Acceptance remains gated on current-candidate CI, synthetic UI evidence and isolated macOS empirical results; no formal installation or real migration is performed by this delivery.

## 最新 Agent 输出与纯时长

- 历史条目缺少完成时间时不提前封闭消息，后续同项增量继续更新；真实完成事件仍阻止迟到增量。

最新输出来源从账本事件改为任务绑定对话，进展与最终回答按平台消息顺序选择，独立输出版本驱动三处局部更新。执行状态与持续时间分开表达，卡片保留状态图标，悬浮卡片和详情保留独立状态文字。真实增量观察与历史补读分别记录，缺少经验验收时保留阻塞。

- 原生观察区分桌面宿主和独立 daemon；在主人确认的边界下允许最小参数加入已加载会话订阅，并通过桌面现有 owner 的只读跟随通道补足真实增量。主线交付单元原子进度与等待状态已整合，整合后的合成视觉证据已确认。

- 共享展示兼容检查与业务写入合同分离；历史只读运行不再强制迁移。主人授权维护迁移保留 owner 和真实操作审计，不要求恢复原主会话；普通 main 迁移权限不变。架构取舍记录于 ADR 0045。

- 自定义 view 声明的路径校验覆盖悬空符号链接，避免将不安全声明当成缺失；兼容回归直接证明拒绝发生于服务状态探测和停止之前。

## 卡片悬浮信息

- 统一任务和交付单元的对话、PR、计时浮层；时间保持覆盖正文的悬浮布局，移除底部预留空间。
- 新增已认证的绑定 PR 只读查询，扩展临时对话投影及交付单元自身执行计时；保持旧账本兼容，不执行数据迁移。

- 看板交付单元列头补齐独立用时入口，保留原有列头高度；缺少自身执行事实时明确显示时间未知。
