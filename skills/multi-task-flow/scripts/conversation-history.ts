import type { JsonRecord, observeCodex } from "./codex-agent-api";
import { record as object } from "./codex-socket";
import type { AgentOutput } from "../web/agent-output";
type ReadConnection = Pick<Awaited<ReturnType<typeof observeCodex>>, "request">;

/** Normalize only public assistant text, never tool/reasoning/user items. */
export function messageOutput(
  thread: string,
  envelope: JsonRecord,
): AgentOutput | null {
  const item = object(envelope.item);
  if (
    !item ||
    item.type !== "agentMessage" ||
    typeof item.id !== "string" ||
    typeof item.text !== "string" ||
    !item.text.trim()
  )
    return null;
  return {
    state: "available",
    text: item.text,
    thread_id: thread,
    turn_id: typeof envelope.turnId === "string" ? envelope.turnId : null,
    message_id: item.id,
    phase: typeof item.phase === "string" ? item.phase : null,
    message_status:
      typeof envelope.completedAtMs === "number" &&
      Number.isFinite(envelope.completedAtMs)
        ? "completed"
        : "in_progress",
    observed_at: new Date().toISOString(),
    stale: false,
  };
}
const unsupported = (error: unknown) =>
  error instanceof Error &&
  /method not found|unknown (?:method|variant)|unsupported method/i.test(
    error.message,
  );

export async function latestConversationOutput(
  thread: string,
  connection: ReadConnection,
): Promise<AgentOutput | null> {
  let cursor: unknown;
  let method = "thread/items/list";
  const cursors = new Set<unknown>();
  while (true) {
    let result: JsonRecord;
    try {
      result = await connection.request(method, {
        threadId: thread,
        sortDirection: "desc",
        limit: 50,
        ...(method === "thread/turns/list" ? { itemsView: "full" } : {}),
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (method === "thread/items/list" && unsupported(error)) {
        method = "thread/turns/list";
        cursor = undefined;
        continue;
      }
      throw error;
    }
    if (!Array.isArray(result.data))
      throw new Error("Unsupported conversation page");
    for (const row of result.data) {
      const envelope = object(row);
      if (!envelope) continue;
      if (method === "thread/items/list") {
        const output = messageOutput(thread, envelope);
        if (output) return output;
      } else {
        if (!Array.isArray(envelope.items))
          throw new Error("Full turn items unavailable");
        for (const item of [...envelope.items].reverse()) {
          const output = messageOutput(thread, { turnId: envelope.id, item });
          if (output)
            return {
              ...output,
              message_status:
                envelope.status === "inProgress" ? "in_progress" : "completed",
            };
        }
      }
    }
    cursor = result.nextCursor;
    if (!cursor) return null;
    if (cursors.has(cursor)) throw new Error("Repeated conversation cursor");
    cursors.add(cursor);
  }
}
