# 编排示例

每个示例使用独立目录；数据定义、需求文档和说明放在对应目录内。真实运行账本不提交到这里。

| 示例 | 内容 | 入口 |
| - | - | - |
| [编排展示与交互验收](orchestration-viewer/README.md) | 两个交付单元、十个贡献任务、原子步骤、等待与阻塞、动态切割及依赖关系 | 在 Skill 目录运行 `bun run preview:source` |
| [单交付单元](single-delivery-unit/README.md) | 完全虚构的文档检索服务，复杂依赖汇聚、发布链与默认任务网格 | `bun run preview:single-delivery-unit` |
| [账本初始化](ledger-initialization/README.md) | 尚未获批的初始化请求模板 | `ledger-initialization/initial.json` |

开发预览复用正式 shared viewer 实现，使用隔离的临时数据与端口，不安装或改写正式服务。前端源码修改后自动构建、刷新；后端修改后重启。停止使用 Ctrl+C。
