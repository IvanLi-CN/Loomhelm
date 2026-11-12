# 依赖模型与任务图

## 目标

定义 AtomicNode、AtomicEdge、Task、DeliveryUnit 和 milestone 的稳定身份与依赖关系。

## 验收

- AtomicNode 与 AtomicEdge 是唯一的依赖真相，图必须无环。
- Task 与 DeliveryUnit 是平级读取投影，不拥有原子副本；跨贡献任务的依赖以显式 edge requirement 和 PR/milestone evidence 表达。
