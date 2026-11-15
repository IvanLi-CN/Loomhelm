# ADR 0035：任务 Agent 以账本自主推进并通过通知交接调度

## 背景

任务 Agent 需要知道自己的任务身份、原子顺序、依赖、验收合同和开发基线。把整张编排图复制到派发消息会造成上下文重复，也容易与账本产生分歧；只发送一句泛化指令又会让 Agent 无法判断 `prepare-branch`、`merge-pr` 和 `closeout` 的关系。

任务执行还存在一个时间边界：当前任务的 PR 合并可能已经满足后继任务的前置条件，但当前任务仍需要完成 `closeout`。因此“后继任务可派发”和“当前任务完成”不能使用同一个事件表示。

## 决策

主 Agent 派发任务时发送最小身份和读取入口，包括 `run_id`、`task_id`、`delivery_unit_id`、任务 Agent 身份、工作区、开发基线以及任务上下文读取方式。任务 Agent 通过只读任务上下文读取自己的原子、任务图和原子图依赖、验收合同、PR 与阻塞事实，然后按账本顺序自主推进到 `closeout`。

任务 Agent 只能写入自己的任务、原子和证据；不能修改其他任务、依赖图或创建其他任务对话。任务 Agent 可以完成自己的工作区准备、实现、验证、PR 创建、PR 合并和收口。

每次可能改变依赖事实的账本提交都运行统一的就绪评估。任务图和原子图分别作为独立门禁；任何一张图都不能从另一张图自动推导依赖。某任务从非就绪状态首次进入 `ready` 时，账本创建一条持久的可派发通知；同一就绪代次不重复通知。

PR 合并写入真实 merge receipt 后即可触发后继任务的就绪评估，即使当前任务尚未完成 `closeout`。当前任务只有在 `closeout` 完成后才产生任务完成通知。

通知采用两阶段交接：账本先记录通知意图，任务 Agent 使用返回的 `tool_request` 通知主 Agent；主 Agent 通过 `notification-ack` 确认收件，再根据当前账本重新校验依赖并调用 `dispatch-claim`。通知确认不等于派发批准，过期通知不能绕过重新校验。

一次提交解锁多个任务时合并为一条通知，通知列出全部新就绪任务。主 Agent 根据并发容量和全局依赖决定派发其中哪些任务，未派发任务继续保持 `ready`。

## 后果

任务 Agent 可以在不等待主 Agent 逐步下达原子指令的情况下完成自己的生命周期，同时账本仍是唯一事实来源。主 Agent 的职责收敛为全局调度、异常升级和派发授权。

账本需要提供任务作用域的只读上下文投影、就绪代次去重和统一依赖评估；通知发送失败必须保留 `pending`、`unknown` 或 `sent` 状态供后续对账。实现不能把 `notification-ack` 当作派发，也不能把 PR 合并当作任务完成。

## 参考

- [Multi-task Flow 术语表](../GLOSSARY.md)
- [Multi-task Flow task execution and delivery boundaries](./0027-multi-task-flow-task-execution-and-delivery-boundaries.md)
- [Unified atomic orchestration](./0029-unified-atomic-orchestration.md)
