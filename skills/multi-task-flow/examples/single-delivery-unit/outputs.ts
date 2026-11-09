import type { Ledger } from "../../lib/schema";
import type { ConnectObserver } from "../../lib/conversation-output";
import { initialOutput, type AgentOutput } from "../../web/agent-output";

const progress: Record<string, string> = {
  contract: "检索请求、过滤条件与错误码已定稿，协议测试通过，贡献已集成到父分支。",
  storage: "文档表与索引元数据结构已完成，迁移及约束测试通过，贡献已集成。",
  writer: "批量写入、幂等更新与失败重试已完成，测试通过，贡献已集成。",
  reader: "查询执行与结果排序已完成，分页与空结果测试通过，贡献已集成。",
  gateway: "检索接口、权限校验与错误映射已完成，接口测试通过，贡献已集成。",
  importer: "历史文档导入与断点续跑已完成，样本核对通过，贡献已集成。",
  container: "镜像构建和启动配置已完成，正在验证健康检查与持久卷挂载。\n接下来核对重启后的索引恢复行为，通过后提交集成。",
};

/** Public assistant text is synthetic and never read from a native conversation. */
export function createSingleDeliveryUnitOutputs(ledger: Ledger): Record<string, AgentOutput> {
  return Object.fromEntries(ledger.tasks.map(task => [task.id, !task.thread_id ? initialOutput(null) : {
    state: "available", text: progress[task.id]!, thread_id: task.thread_id,
    turn_id: `mock-turn-${task.id}`, message_id: `mock-message-${task.id}`,
    phase: task.state === "running" ? "commentary" : "final_answer",
    message_status: task.state === "running" ? "in_progress" : "completed",
    observed_at: task.finished_at ?? ledger.updated_at, stale: false,
  }]));
}

/** Source-preview adapter uses the production output projection without native I/O. */
export function singleDeliveryUnitObserver(ledger: Ledger): ConnectObserver {
  const byThread = new Map(Object.values(createSingleDeliveryUnitOutputs(ledger)).filter(output => output.thread_id).map(output => [output.thread_id, output]));
  return async () => ({
    close() {},
    async request(method, params) {
      if (method !== "thread/items/list") throw new Error(`Unsupported mock method: ${method}`);
      const output = byThread.get(String(params.threadId));
      return { data: !output ? [] : [{ turnId: output.turn_id, item: { type: "agentMessage", id: output.message_id, text: output.text, phase: output.phase }, ...(output.message_status === "completed" ? { completedAtMs: Date.parse(output.observed_at!) } : {}) }], nextCursor: null };
    },
  });
}
