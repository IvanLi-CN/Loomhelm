# ADR 0040：初始化恢复的权限事务与原生写锁

## Status

Accepted；supersedes ADR 0038。发布与安装升级独立处理。

## Context

ADR 0038 的实现将 read-only/never 直接传给 resume；原生配置对后续 turn 持续生效，导致正式任务继承握手权限。仅移动到 turn/start 同样不能保证权限只作用于握手。本决策保留单次握手、独占 writer 与 unknown 对账边界，增加原权限持久化、恢复及核验事务。

ADR 0034 的 `creation-reconcile` 只查询既有结果，不能使只有初始化用户消息、没有助手回复的 interrupted turn 变为 completed。重复创建会丢失已观察到的 thread/worktree 身份；将任意后续 READY 当作首次初始化完成则会丢失审计链。外层 CLI 的默认 30 秒预算还短于原生初始化的 300 秒预算。

## Decision

保留 `creation-reconcile` 的只查询原生结果语义，新增显式 `initialization-recover`，仅允许绑定 main 对 unknown 的 codex-exec 创建操作恢复一次固定握手。原始 turn 必须是 interrupted；failed、active、额外业务 turn、工具调用、未知 items 或不完整历史均拒绝。精确识别两种历史角色文本及当前握手文本，允许 interrupted 握手没有助手回复。

恢复前原子追加唯一 attempt，冻结创建 native request、thread、原始 turn 与 items 摘要、角色提示版本及摘要、执行配置、独立 worktree 和 HEAD。attempt 永不过期、不重置；崩溃、超时、断线或 revision 冲突后只读取并对账该 attempt，不能自动重发。若 intent 已保存但无法证明原生 turn 是否启动，保持 unknown，需独立审计处理。

单独的 `codex exec resume` 无法在读历史与发送之间持有写锁，因此恢复使用任务独占、仅临时私有 Unix socket 的临时 `codex app-server`。它在同一 thread 上取得原生 writer 锁后再次读取完整历史，确认仍只有原始 interrupted 初始化，再发送包含 attempt/original-turn 标识的固定 READY 握手。禁止新建 thread、fork、创建 worktree、正式派发或永久改变原执行配置；不操作共享 daemon；私有进程显式禁用 `daemon_auto_start`。原生 0.169.0 为长 Unix 地址创建的路径摘要 alias 仅在目标精确等于本次私有地址 SHA256 对应 socket 时接受；退出时只删除本次目录内的 alias，不删除其外部目标。此路径是 ADR 0034 与 Contract 3 禁止直接 resume/start 的唯一受审计恢复例外，不是通用对话控制入口。

当前仅启用已实测 writer 排斥的 `codex-cli 0.169.0`；其他版本报告 capability unavailable，禁止回退到无排斥的发送路径。恢复 writer 先以不含 model、cwd、sandbox 或 approval override 的中性 resume 取得锁；从原生响应读取完整 sandbox policy、approval policy 与 approvals reviewer，并在第一次权限修改前原子追加到当前 attempt 的版本化 permissions 快照。不得从执行 profile、全局默认值或新版本配置推断原权限。命名 permissions profile 或原生配置缺失时，在修改权限前拒绝恢复。握手通过 `thread/settings/update` 使用 read-only sandbox、never approval、原 reviewer、全局截止时间、现有进程树监管及工作 item 检测；任何工具/审批请求或工作 item 均终止并拒绝绑定。父进程终止信号须先中断等待、监管并关闭私有进程、清理本次 socket 后再传播。

原生返回 recovery turn identity 后立即追加观察；结束时复读原始 interrupted turn 和已登记的 completed recovery turn，核对精确提示、唯一 READY、配置、owner、HEAD 和清洁状态，最终核验、原权限恢复和同一 dispatch 成功写入必须处于同一次原生 writer 锁持有期间；释放锁后才准备一次 handoff notification。已登记 attempt 的对账也必须取得同一 writer 排斥，不得发送新 turn；允许恢复该 attempt 尚未恢复的权限。恢复原权限使用不发送 turn 的 `thread/settings/update`；实际恢复写入必须取得目标 thread 的 `thread/settings/updated` effective settings 并逐字段核对原始快照，不能仅信任空成功响应；中性 resume 已证明当前配置等于原快照时不重复写入。恢复失败不得标记 dispatch succeeded 或准备 handoff。正常异常尽量在释放锁前恢复；断线、超时和进程死亡保留快照及 unknown，后续只对账恢复，不重发 READY。重入时当前权限必须等于原始快照或本 attempt 的握手限制，否则拒绝覆盖可能由 owner 改动的配置。旧 attempt 没有权限快照时仅保留读取和独立审计路径，禁止猜测、自动回填或重发。成功 evidence 绑定原权限快照摘要；同一快照不得被后续请求修改。

原始 turn 不改写为 completed，不以“最新 turn”替代注册链。新状态为 operation.request 的可选审计字段，不新增业务状态，不迁移或清理历史数据。

创建与恢复的外层预算必须覆盖原生初始化预算及200 秒有界历史读取、Git 身份核验和关闭余量；显式配置不足时在副作用前拒绝。普通读取命令继续使用原配置。

## Alternatives

- 直接重试 conversation-create：会重复创建，拒绝。
- 用 app-server 的共享 control socket 执行 turn/start：可能与其他客户端并发或变为 steering，拒绝。
- 先查历史再 exec resume：存在读取与取得 writer 锁之间的历史变更窗口，拒绝。
- 修改原 turn 状态、把 failed 当 interrupted、接受任意 READY：缺少可信因果链，拒绝。

## Verification

验证两角色和历史文本、prompt-only interruption、危险 items、writer 排斥、锁内历史再校验、注册前/后崩溃、重复请求、revision fencing、配置/目录/HEAD 冲突、原始与恢复 turn identity、成功绑定和通知幂等。原生验收只使用 disposable 仓库、账本与会话，不修复生产运行。
