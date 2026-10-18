# Loomhelm 设计包

本目录将已确认的视觉语言、风格选择依据、桌面与手机布局、UX 约束和实施交接放在同一套可追溯资料中。完整 UI 仍在同一个 D01 设计任务内推进，当前接受范围不等于产品 UI 实施授权。

| 内容 | 入口 | 状态与用途 |
| - | - | - |
| 完整设计入口 | [统一入口](../../design/index.html) | 同一个 D01 完整设计入口；`index.html` 当前默认重定向到 `layouts.html`，完整 UI 仍待主人确认 |
| UI 设计语言 | [语言板](../../design/ui-language.html)、[设计系统](DESIGN.md)、[机器可读规则](.impeccable/design.json) | 已确认 D 半透明材质、亮暗配对及展示的语言样张 |
| 风格选择依据 | [风格板](../../design/styles.html)、[选择记录](surface-brief.md#ui-style-selection) | 保留四种候选及 D 的取舍，选定后不重新混合风格 |
| 桌面与手机主要布局 | [布局与体验](../../design/layouts.html) | 工作台、任务三视图、项目范围、全部对话与独立/任务对话；当前 10 张合成捕获聚焦 graph/info，30 项定向检查含项目范围与权限 DOM 子集；已确认仅保留 [跨项目桌面亮色示例](../../design/evidence/layout-cross-project-desktop-light.png) 与 [关系信息手机暗色示例](../../design/evidence/layout-relations-info-mobile-dark.png)，完整 UI 仍待主人确认 |
| UX | [体验规则与状态矩阵](UX.md) | 导航、草稿、多端、绑定、审批、恢复与移动重排 |
| 实施交接 | [交接与依赖](HANDOFF.md) | 页面、组件、状态与真实接口输入的边界 |
| 已接受的视觉证据 | [证据目录](../../design/evidence)、[来源与接受范围](surface-brief.md#visual-evidence) | 保留导航结构、D 主题样张、独立语言板及上述两张已确认的主要布局示例 |
| 结构参考 | [早期原型](../../design/index.html?prototype=1) | 信息架构参考；不作为当前页面视觉设计或完整 UI 批准 |

完整设计仍只有一个入口：访问 `design/index.html` 默认进入 `design/layouts.html`；`design/ui-language.html` 是单独接受的 UI 语言板，`design/styles.html` 和 `design/index.html?prototype=1` 继续作为保留的样式选择与结构原型来源，已接受的 ui-language/styles 源与证据字节保持不变。静态 UX 规则与实现交接分别保留在 [UX.md](UX.md) 和 [HANDOFF.md](HANDOFF.md)，不会被入口重定向或临时演示替代。

静态预览以 `design/` 为服务根目录；`layouts.html` 内可切换亮色、暗色、系统主题与关键状态。桌面和手机由同一页面响应式重排，任务列表、看板、图谱的选择按当前浏览器与全局/项目范围分别记忆。导航、审批、发送、创建与关联仅改变演示状态；草稿与主题的浏览器存储也不证明真实跨设备同步。当前迭代沿用已确认 D 方向，不重新选择样式；DL-08/LH-30/SN-12 跨项目 fixture、“权限已变更”安全回退、10 张最终合成捕获和 30 项定向合成检查均已完成，其中新捕获聚焦 graph/info、工作台仅有权限 DOM 路由检查，最新复核仅对 IMP01/IMP02 返回 scoped `disposition: ship`，不等于 D01 或产品 UI 批准。实际服务合同、服务器及两端授权、跨设备/PWA 验证和完整 UI 主人确认仍是后续输入。

后续设计提交须一起保留语言源文件、桌面/手机主要布局示例、风格选择资料、UX 与交接说明，以及已接受的证据。页面评审继续使用当前 D 语言；如果发现能力或业务合同未定，交回协调者收敛，不以设计演示替代合同。DESIGN/token/JSON 与已接受的语言板、风格板字节保持不变；主人已确认仅保留上述两张主要布局示例，且两张图像已写入 canonical evidence，但这不等于 D01 或完整 UI 批准。两张图像相对实际 parent `079d3d85318c365056cd29a238aafdf732581421` 仍是 current-only 比较，因无 baseline、heatmap 或 two-sided regression report 而需后续确认；主要布局和完整 UI 仍待主人确认。
