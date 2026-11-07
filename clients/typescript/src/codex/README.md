# Codex app-server 适配

本模块在 Bun 1.4.4 中使用标准 API，通过独立子进程的 stdio NDJSON 连接本机 Codex app-server；调用入口为源码 `src/codex/index.ts`，不依赖 Loomhelm 服务端、Web App 。只有显式调用 `CodexAppServer.start()` 才启动进程。

协议来源为本机 `codex-cli 0.166.0` 的 `codex app-server generate-ts` 稳定输出和 [官方 app-server 文档](https://developers.openai.com/codex/app-server)。`protocol.ts` 保存所用参数、响应、服务器请求及依赖的生成类型；生成脚本只移除重复生成头和内部 import，将依赖闭包合并为一个文件，不自行推断字段。升级协议时，在本包目录执行 `bun src/codex/generate-protocol.mjs`，审核差异并重跑行为测试。服务器仍使用已有本机 Codex 配置与凭据；适配器不读取、复制或上传凭据。

## 调用与生命周期

```ts
import { CodexAppServer } from './src/codex/index.ts';

const codex = await CodexAppServer.start({
  onEvent(event, value) {
    // Persist/route events and approval requests in the owning application.
  },
});
try {
  const { thread } = await codex.startThread({ cwd: '/absolute/repository' });
  const { turn } = await codex.startTurn({
    threadId: thread.id,
    input: [{ type: 'text', text: 'Inspect the project', text_elements: [] }],
  });
  // This response acknowledges a turn; track turn/completed independently.
} finally {
  await codex.stop();
}
```

`start()` 等待 `initialize` 响应，再发送不带 ID 的 `initialized` 通知，之后才交付 ready 实例。`command`、参数数组、cwd、env 和初始化身份可显式传入；不经过 shell。默认继承本机环境。初始化失败会停止已创建的进程。`state` 与 `pid` 提供当前进程身份；`stop()` 可重复调用，先结束 stdin，超过宽限期后仅向直接拥有的子进程发送 TERM/KILL，并等待真实 close。模块不负责子进程派生的后台服务或进程树。

支持 `startThread`、`resumeThread`、`forkThread`、`readThread`、`listThreads`、`listTurns`、`setThreadName`、`startTurn`、`interruptTurn` 和 `listModels`；参数与分页游标保持官方格式。线程配置中的 reasoning effort 使用 `config.model_reasoning_effort`，turn 使用 `effort`。方法返回服务器响应，不自动推进任务状态。turn 启动响应与 turn 最终完成是两个不同事实，只有 `turn/completed.params.turn.status === 'completed'` 表示成功，`failed` 和 `interrupted` 必须由上层分别处理。

## 事件和审批边界

`onEvent` 在初始化前已连接，适合承接早期通知和服务器请求；实例的 `on()` 可追加订阅并返回取消订阅函数。`notification` 按接收顺序保留方法名与 params，包括未知通知、重复事件、工具调用、文件引用、文本 delta 和执行结果。UTF-8 数据按完整换行帧解码。此层没有事件去重、终态缓存或持久化回放，不会丢弃早于启动响应到达的完成通知；上层必须在启动 turn 前接入事件处理。

带 ID 的服务器消息通过 `serverRequest` 显式转交，包含原始 `id`、`method`、`params` 和一次性 `respond(result)` / `reject(error)`。`approval` 标识命令、文件、权限及兼容旧协议审批；工具输入、动态工具、认证刷新和未知服务器请求也显式转交，由调用方决定处理或返回官方 RPC 错误。适配器不自动接受、拒绝、代填审批或执行工具。无人处理的请求保持待决，达到容量上限才关闭连接。调用方必须提供审批展示、授权与答复策略；错误的本地答复不会被默认解释为批准。

答复写入管道成功只表示本地写入完成，不代表服务端已经接受。每个句柄只能答复一次；断连和 `serverRequest/resolved` 会使旧句柄失效。答复发送失败关闭连接，禁止使用旧句柄重试。事件处理器同步异常和异步拒绝通过 `handlerError` 交出，不破坏请求响应关联。`stderr` 是瞬时诊断流，模块不留存；调用方应按自身敏感信息政策处理。

## 断连、超时与恢复

请求 ID 使用连接随机身份与序号关联，允许并发和乱序响应，客户端与服务器请求的 ID 空间分开。`CodexRequestError` 保留 `requestId`、`method`、`outcome` 和可用的 `rpcError`：

- `not-sent`：本地序列化、帧大小或待决请求容量检查失败，尚未发送。
- `rejected`：收到对应 RPC 错误，保留 code、message 和 data。
- `unknown`：写入开始后超时、断连、停止或收到无效响应，不能推定外部操作失败。

超时只结束本地等待，不取消服务端操作；迟到或重复响应通过 `orphanResponse` 交出。断连会拒绝全部待决请求、撤销审批句柄并清理内存。非法 RPC 信封、必要身份形状错误、过大帧、stdout EOF 和进程异常也触发关闭；未知通知保留兼容性。默认单帧上限 8 MiB，每个方向各最多 1024 个待决请求，请求默认超时 30 秒，停止宽限期为 500 毫秒，可用 options 调整。

恢复必须由上层显式启动新实例、完成握手，并使用已保存的 thread ID 执行 `readThread`、`listTurns` 或 `resumeThread` 对账。模块不自动重放 `thread/start`、`thread/fork` 或 `turn/start`，避免 ACK 丢失后重复创建工作。Loomhelm Task、Run、operation identity 与 Codex thread/turn 的持久关联、跨进程事件游标和业务重试策略属于 dispatch/orchestration 的账本边界，本模块只传递协议身份和不确定性。

## 验证

```sh
bun run check
bun run test
```

`test/codex.test.mjs` 使用独立 Bun 伪服务器，在实际 Bun 进程中运行同一适配实现。覆盖握手、请求乱序、官方方法和参数转发、拆分 UTF-8、重复事件、启动响应前的终态、审批显式答复和失效、RPC 错误、超时与迟到响应、帧和请求容量上限、非法响应、断连与 stdout EOF、监听器异常、启动失败以及忽略 TERM 的进程回收。测试不启动真实 Codex、不调用模型、不使用账号或网络。
