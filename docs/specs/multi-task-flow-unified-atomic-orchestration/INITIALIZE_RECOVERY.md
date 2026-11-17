# initialize 安全恢复与操作边界

## 能力审计

受支持历史来源为 `@loomhelm/multi-task-flow@0.5.0`，source SHA `699039788de4abfcb5eca1a89e873ee153a007e6`，build ID `5519468bd9c8b25bcc1c01b659e76e8148757433ba134d2941067511d059dbce`，compatibility line `compat-v1`，contracts 为 ledger 5、API 1、frontend 1、viewer 5。已对比 npm 缓存包的 artifact identity、源文件与该提交，未以版本号单独信任来源。

| 源文件 | SHA-256 |
| - | - |
| `codex-rpc.ts` | `118e5ce38d2f4e104bccaf9a4251e06b5cd96e37e7b5b322d162c8437b1fdd59` |
| `codex-agent-api.ts` | `6a2f082d8ec3b08b6a01927a7dd569dda15d0c13eac1f4abf9c27fb79a223585` |
| `invocation-journal.ts` | `01fede147cf9026e98bfad12a947ef875ac3f1d1732620439abb3901fb0d7eb5` |
| `orchestration-lifecycle.ts` | `bd52db5000a19d29acbe2d502db635a79a83169ced747a947196dc0d6d18c54b` |
| `conversation-archive.ts` | `b0058e4615692991691b741ba736dcf229479ba4a889d04c624f1371e86aa71c` |
| `server.ts` | `fcc6c4803b40c7bbee18bc7c68adb0b1bb740da9eb6a8ceece90d4d24c40a1d3` |

该来源的 `rpc` 在 socket write 前记录 request intent，只有匹配 response 才记录 terminal；连接 close 仅记录 transport terminal。`withCodexArchiveConnection` 先 await initialize，再进入 thread/read 和 thread/archive；initialize 抛错时不能进入业务 action。`executeInvocation` 在 action 结束后禁止新增已登记资源并记录 execution-finished。后台归档入口与 dashboard HTTP 包装可能使用默认 unknown/null；因此不能据此断言具体 archive operation 的来源或结果。

精确请求为 id `1`、method `initialize`、`clientInfo={name: "multi-task-flow", version: "1"}`、`capabilities={}`，canonical params digest 为 `22feeea966ba86f112476e3bce4d1022a23090779962ffc8c5fb6f675d461470`。该握手不携带 thread、turn 或业务 operation 参数。

原生边界参考 OpenAI Codex [initialize 处理器](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/request_processors/initialize_processor.rs) 和 [连接会话与请求分发](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/message_processor.rs)。initialize 设置连接能力及客户端元数据并回复，不提交项目 turn/archive；其中客户端身份、登录策略及遥测处理不是本恢复所回滚或确认的事项。不能将此结论泛化为任意 provider 请求无副作用。

## 允许的证明

- start、execution-finished 的 schema、invocation、run、身份和 start digest 完整匹配。
- 恰好一个合法 transport intent 和一个精确 initialize intent；transport terminal 绑定原 intent 且只确认 local_transport_closed。
- 没有 request terminal、其他资源或未知 journal 条目；源记录未被替换、篡改或跨 invocation 拼接。
- 历史来源匹配上述完整身份，保留 command=unknown、actor=null、input digest 对应空对象；新来源必须有首请求 scope 和 transport 关联。
- 专用 reconcile 仍核验绑定 main、request_id、revision、marker digest 与 inspect 返回的完整 evidence refs；任何条件不足均拒绝。

inspect 的 `recovery` 返回规则、资格、阻塞原因和 proof digest。符合恢复条件时，顶层 `evidence_refs` 精确覆盖 start、execution-finished、两个 intent 和 transport terminal 的 canonical 摘要，恢复前后保持稳定；普通完整调用继续返回 resource terminal 摘要。调用方应原样使用 inspect 返回值，不能自行拼接 refs。

凭证依次追加 `initialize-recovery.json`、`reconcile.json`、`stopped.json`，最后发布 marker。每次读取重新验证源证明；相同 canonical request 可从任一已发布边界续接，凭证冲突保持拒绝。未发布 `.event-*` 临时文件不充当证据。reconcile 不执行原生请求，也不修改业务 ledger。

## 发布后正式操作

这些步骤需要独立的正式现场授权，本轮源码修复、合并或副本测试均不隐含该授权。

1. 核验 Merge Receipt、发布版本、build/source、包完整性及 deployment identity 与真实 merge SHA 一致，使用经过验证的发布 CLI，不能使用 dirty 工作区产物操作正式 run。
2. 在现有 writer 排斥和维护流程内保存正式 run 的一致备份及摘要；确认 invocation、revision、binding 和副本证明一致，变化则重新检查。
3. 由绑定 main 使用目标 CLI 的 `flow invocation-inspect --input -`。保留完整输出，要求 recovery eligible，逐项核对 source/executor 与缺失项。
4. 使用标准 mutation envelope 执行 `flow invocation-reconcile --input -`：payload 精确使用 inspect 的 invocation_id、marker_digest、evidence_refs，使用当前 expected_revision 和新的 request_id。中断后保留同一请求重试，禁止换身份覆盖旧凭证。
5. 再 inspect，要求 quiescent=true；核对业务 ledger 摘要不变。任何拒绝都停止，不清空 marker、不伪造 terminal。
6. 按既有 orchestration upgrade 合同显式前向升级到同一已验证目标，检查 binding、ledger、upgrade 完成和 worker 身份。升级或服务维护的实际操作仍受本次正式授权范围约束。
7. 由原绑定 delivery agent 启动 v1、更新 atom；保留原 ownership。启动成功只证明生命周期解除阻塞，真正的项目验收仍需按 v1 的工作内容完成。

## 兼容性

公共 CLI mutation envelope 保持兼容，inspect 增加字段；接口影响为 patch。持久状态新增独立能力证明，旧程序不理解且必须拒绝，持久状态影响为 minor。此分类不选择发布 target；版本、channel 和发布触发由仓库发布合同及主人确认决定。

迁移记录见 [initialize-recovery-migration.json](initialize-recovery-migration.json)。不自动删除历史内容、不降级或反向迁移；停止中的发布由新程序前向续接。
