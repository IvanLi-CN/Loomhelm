export type AgentOutput = {
  state: "available" | "no_conversation" | "empty" | "unavailable";
  text: string | null;
  thread_id: string | null;
  turn_id: string | null;
  message_id: string | null;
  phase: string | null;
  message_status: string | null;
  observed_at: string | null;
  stale: boolean;
  agent_state?: "active" | "idle" | "unknown";
};
export type OutputSnapshot = { output_epoch: string; output_revision: number; outputs: Record<string, AgentOutput> };
export function initialOutput(thread: string | null): AgentOutput {
  return { state: thread ? "unavailable" : "no_conversation", text: null, thread_id: thread, turn_id: null, message_id: null, phase: null, message_status: null, observed_at: null, stale: !!thread };
}
export function outputLabel(output: AgentOutput): string {
  return output.state === "no_conversation" ? "尚未创建任务对话" : output.state === "unavailable" ? "Agent 输出暂时不可用" : "尚无 Agent 输出";
}
export function paintOutput(node: HTMLElement, output: AgentOutput, full = false): void {
  const signature = JSON.stringify([output.text, output.state, output.stale, full]);
  if (node.dataset.outputSignature === signature) return;
  node.dataset.outputSignature = signature;
  const content = output.text?.trim();
  node.replaceChildren();
  node.classList.toggle("is-empty", !content);
  node.classList.toggle("is-stale", output.stale);
  const label = outputLabel(output);
  node.dataset.emptyLabel = label;
  node.setAttribute("aria-label", content ? `最新 Agent 输出：${content}${output.stale ? `（${label}）` : ""}` : label);
  if (content) {
    const body = document.createElement("span"); body.className = "agent-output-text";
    body.textContent = full ? output.text! : content.replace(/\s+/g, " "); node.append(body);
    if (output.stale) {
      const warning = document.createElement("span"); warning.className = "agent-output-warning"; warning.textContent = `（${label}）`; node.append(warning);
    }
  }
  node.dataset.tooltip = content ?? label;
}
/** Fence GETs by their starting epoch; retire replaced instances across both channels. */
export class OutputSnapshots {
  private current: OutputSnapshot | null = null;
  private retired = new Set<string>();
  get epoch(): string | null { return this.current?.output_epoch ?? null; }
  accept(next: OutputSnapshot, requestEpoch?: string | null): OutputSnapshot | null {
    if (!next || typeof next.output_epoch !== "string" || !Number.isSafeInteger(next.output_revision) || next.output_revision < 0 || !next.outputs || typeof next.outputs !== "object") return this.current;
    // A transition while the GET was in flight makes an unfamiliar epoch stale too.
    // Same-epoch catch-up remains valid; an unopposed fresh GET can discover a restart.
    if (requestEpoch !== undefined && requestEpoch !== this.epoch && next.output_epoch !== this.epoch) return this.current;
    if (this.retired.has(next.output_epoch)) return this.current;
    if (this.current?.output_epoch === next.output_epoch && next.output_revision < this.current.output_revision) return this.current;
    if (this.current && this.current.output_epoch !== next.output_epoch) this.retired.add(this.current.output_epoch);
    return this.current = next;
  }
}

/** Also refresh previews built while detached, immediately before opening them. */
export function refreshOutputNodes(root: ParentNode, tasks: Array<{ id: string; latest_agent_output?: AgentOutput }>): void {
  const byId = new Map(tasks.map(task => [task.id, task.latest_agent_output]));
  for (const node of root.querySelectorAll<HTMLElement>("[data-output-task-id]")) {
    const output = byId.get(node.dataset.outputTaskId!);
    if (output) paintOutput(node, output, node.dataset.outputFull === "true");
  }
}
