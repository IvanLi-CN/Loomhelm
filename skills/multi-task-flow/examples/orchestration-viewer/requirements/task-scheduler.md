# 原子编排与 PR 合并（调度与 PR 合并协调）

## 目标

依据 AtomicEdge、里程碑条件、并发名额和持久操作占用调度原子 work 与 PR 合并。

## 验收

- 只有满足原子入边条件且有可用名额的 work 原子才能执行。
- 里程碑只有所有入边条件和显式验收条件满足时才达成；等待属于派生状态，不创建等待或 coordination Task。
- DeliveryUnit 集成 PR、子 PR、CI、发布、部署和线上验证通过外部事实与对应 milestone 表达。
