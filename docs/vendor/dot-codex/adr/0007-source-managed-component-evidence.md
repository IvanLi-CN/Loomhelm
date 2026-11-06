---
status: accepted
---

# 组件证据采用源管理展示面

## Context

组件截图曾尝试从像素推断背景、裁掉多余边缘并补出外边距。这个过程无法判断留白是否属于组件主题，也无法区分自然画布与额外画框；实际结果会制造与组件无关的边框、重复留白或嵌套卡片观感。

## Decision

- 选作组件、片段或可复用状态证据的 Story/docs DOM 必须声明 `data-visual-evidence-surface` 和其内的 `data-visual-evidence-target`。
- 展示面由源代码拥有：使用真实主题的自有不透明纯色背景，并保留目标的自然外边距；不得为证据添加边框、圆角、阴影、专用颜色或嵌套卡片。
- 截图流程只做一次 DOM 预检，量化目标与展示面的四边间距。它可在展示面内按已知几何范围收紧超过上限的空白，但不得注入 DOM、改样式、补边、像素推断背景或存储测量回执。
- 页面和完整页面 Storybook fallback 继续使用已有 `trim_only` 图像路径。`require_margin` 保留为 helper 兼容参数，但必须在像素分析前阻断并要求源管理展示面。

## Consequences

- Storybook stories 成为组件证据空间的唯一权威，截图 Agent 不再承担视觉设计决策。
- 无法自然提供展示面的组件证据会阻断并返回 Story authoring，而不会生成带假边框的图片。
- 该合同不新增业务仓库 CI、`play`、测试配置或 owner-facing 测量字段。

## Related Specs

- [Visual evidence whitespace trim](../specs/visual-evidence-whitespace-trim/SPEC.md)
