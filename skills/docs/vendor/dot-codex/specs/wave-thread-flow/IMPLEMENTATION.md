# 实现说明

Wave Thread Skill、旧状态机、CLI、派发 Profile 回放和专属测试均已删除。共享编排与验收解析保留给 `multi-task-flow`。Python 迁移基线中的相关映射标为 `retired`，不再执行。运行时 CODEX_HOME 不在本变更部署范围内。

现行多任务编排覆盖正向解析、Profile、Skill、依赖、归属、验收范围、拓扑和投影。迁移证据退休状态必须绑定原始基线来源；CI 不再调度已删除的 waves suite。其他直接流程的历史 JSONL 校验不属于 Wave Thread 状态兼容能力，继续保留。
