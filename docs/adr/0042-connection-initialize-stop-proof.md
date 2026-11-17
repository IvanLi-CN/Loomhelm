---
status: accepted
---

# ADR 0042：连接初始化的能力停止证明

## 决定

安全停止允许一种严格限定的能力证明：精确的 `initialize` 请求在其唯一 transport 已关闭、执行已经结束、没有其他资源或请求时，可以追加 `initialize-recovery.json`，记录 `unconfirmed_connection_closed`。它证明该连接不能继续项目业务，不证明请求成功、不补造 provider 响应、不回滚已经发生的客户端元数据或遥测处理。

正常终结、inspect 和 reconcile 使用同一验证器；验证器每次从不可变源记录重新计算证明，不能只相信凭证或 stopped 投影。凭证绑定规则版本、源记录摘要、source/executor 身份。旧 reader 因缺少原 request terminal 而继续拒绝，不能自动降级继续写。

## 历史边界

没有 transport 关联字段的旧记录只支持经审计的 `@loomhelm/multi-task-flow@0.5.0` build `5519468bd9c8b25bcc1c01b659e76e8148757433ba134d2941067511d059dbce`、source `699039788de4abfcb5eca1a89e873ee153a007e6`。唯一 transport、唯一精确 initialize、匹配的关闭和 execution-finished 记录共同约束同一 invocation。未知 command/actor 保留未知，不推断 archive operation 身份；其他来源不能凭自行声明 effect scope 使用历史例外。

新调用在 request intent 绑定 transport，并仅为连接首个、参数精确匹配的 initialize 标记受支持 scope。缺少新凭证的未审计历史构建仍拒绝，当前 executor 的相同来源可生成新证明；已有凭证按来源、执行者身份与原记录重新验证。

## 取舍与关系

代价是显式维护已审计来源及保留旧 reader 的拒绝边界；收益是不依赖 PID 消失，也不把任意 unknown RPC 推断为已完成。业务 RPC、turn、其他 native resource 或额外 journal 记录仍阻断。使用同一 invocation 目录追加凭证，避免建立独立恢复账本。

本决定补充输出与调用停止合同，不改变 [ADR 0041](0041-historical-side-effect-quiescence-audit.md) 的机械升级边界：保留 unknown 的升级不等于静止，停止对账也不等于升级。恢复审计与操作步骤见 [恢复说明](../specs/multi-task-flow-unified-atomic-orchestration/INITIALIZE_RECOVERY.md)。
