# Wave Thread 移除边界

## Context and Scope

Wave Thread 的 Skill、状态机、历史读取、事件回放和 CLI 不属于可用功能。多任务协调使用 `multi-task-flow`；现行编排解析器保留其共享职责。

## Requirements

- REQ-WTF-REMOVAL: 仓库不得提供 Wave Thread Skill、历史状态读取、回放、派发或迁移入口。
- REQ-WTF-SHARED: 移除旧实现必须保留现行 `multi-task-flow` 的编排、验收及直接交付能力。
- REQ-WTF-HISTORY: 历史 ADR、主题历史和 Python 迁移基线仅作证据保存，不得充当可执行入口；已退休映射不得宣称当前可执行验证成功。

## Verification

- VER-WTF-REMOVAL covers: REQ-WTF-REMOVAL, REQ-WTF-HISTORY. 验证 Skill 和 CLI 缺席，旧分派失败，迁移映射显式退休。
- VER-WTF-SHARED covers: REQ-WTF-SHARED. 验证现行多任务编排、验收、Profile 和直接流程测试通过。

## Related ADRs

None
