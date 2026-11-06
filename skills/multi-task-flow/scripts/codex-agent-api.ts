import type { ProfileCapabilities } from "./execution-profile";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { websocketFrame as controlFrame } from "./codex-socket";
import {
  record,
  socketPath,
  connectSocket,
  rpc,
  startTurnAndWait,
  framePayload,
  parseRpc,
} from "./codex-rpc";
export type CodexDeliveryOutcome = "sent" | "failed" | "unknown";
export type CodexDeliveryResult = {
  outcome: CodexDeliveryOutcome;
  provider_receipt: {
    provider: "codex-app-server";
    evidence_ref: string;
    message_id?: string | null;
  };
  error?: string;
};
export type CodexThreadCreateResult = {
  outcome: "succeeded" | "failed" | "unknown";
  native_request_id: string;
  thread_id?: string;
  model: string;
  thinking: string;
  evidence_ref: string;
  error?: string;
};

export async function sendCodexMessage(input: {
  recipient_thread_id: string;
  prompt: string;
}): Promise<CodexDeliveryResult> {
  const callId = randomUUID();
  const path = socketPath();
  if (!path)
    return {
      outcome: "failed",
      provider_receipt: {
        provider: "codex-app-server",
        evidence_ref: `codex-app-server:${callId}:unavailable`,
      },
      error: "Codex app-server control socket is unavailable",
    };
  let socket: Socket | undefined;
  let retained = false;
  try {
    const connected = await connectSocket(path);
    socket = connected.socket;
    const buffer = { value: connected.buffer };
    const initialized = await rpc(socket, buffer, 1, "initialize", {
      clientInfo: { name: "multi-task-flow", version: "1" },
      capabilities: {},
    });
    if (initialized.error)
      throw new Error(
        String(
          record(initialized.error)?.message ??
            "Codex app-server initialization failed",
        ),
      );
    // Subscriptions are connection-local. A completed bootstrap may already
    // have been unloaded when its next notification opens a new connection.
    // Resume the exact known identity without configuration or history overrides;
    // never create a replacement thread when this fails.
    const resumed = await rpc(socket, buffer, 2, "thread/resume", {
      threadId: input.recipient_thread_id,
      excludeTurns: true,
    });
    if (resumed.error)
      throw new Error(String(record(resumed.error)?.message ?? "Codex app-server rejected thread/resume"));
    const started = await rpc(socket, buffer, 3, "turn/start", {
      threadId: input.recipient_thread_id,
      input: [{ type: "text", text: input.prompt }],
      clientUserMessageId: callId,
    });
    if (started.error)
      throw new Error(
        String(
          record(started.error)?.message ??
            "Codex app-server rejected turn/start",
        ),
      );
    const turn = record(record(started.result)?.turn);
    if (typeof turn?.id !== "string") throw new Error("Codex app-server omitted accepted turn identity");
    // Publish acceptance promptly so the recipient can acknowledge the ledger
    // notification during its turn. Keep this host-owned process subscribed
    // until the exact turn terminates: disconnecting on acceptance interrupts
    // receivers that have no other subscriber. No detached process is created.
    retained = true;
    retainAcceptedTurn(socket, buffer, input.recipient_thread_id, turn.id);
    return {
      outcome: "sent",
      provider_receipt: {
        provider: "codex-app-server",
        evidence_ref: `codex-app-server:${callId}`,
        message_id: typeof turn?.id === "string" ? turn.id : null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: message.includes("timed out") || message.includes("turn ended with status") || message.includes("closed the WebSocket") ? "unknown" : "failed",
      provider_receipt: {
        provider: "codex-app-server",
        evidence_ref: `codex-app-server:${callId}:error`,
      },
      error: message.slice(0, 500),
    };
  } finally {
    if (!retained) socket?.destroy();
  }
}

function retainAcceptedTurn(socket: Socket, buffer: { value: Buffer }, threadId: string, turnId: string): void {
  const close = () => { socket.off("data", consume); socket.off("error", close); socket.off("close", close); socket.destroy(); };
  const consume = (chunk: Buffer) => {
    try {
      buffer.value = Buffer.concat([buffer.value, chunk]);
      while (true) {
        const frame = framePayload(buffer.value);
        if (!frame) return;
        buffer.value = buffer.value.subarray(frame.consumed);
        if (frame.opcode === 8) { close(); return; }
        if (frame.opcode === 9) { socket.write(controlFrame(frame.payload, 10)); continue; }
        const message = parseRpc(frame.payload);
        const params = record(message?.params);
        if (message?.method === "turn/completed" && params?.threadId === threadId && record(params.turn)?.id === turnId) { close(); return; }
      }
    } catch { close(); }
  };
  socket.on("data", consume);
  socket.once("error", close);
  socket.once("close", close);
  consume(Buffer.alloc(0));
}

export async function createCodexThread(input: {
  title: string;
  prompt: string;
  model: string;
  thinking: string;
  native_request_id?: string;
}): Promise<CodexThreadCreateResult> {
  const nativeRequestId = input.native_request_id ?? randomUUID();
  const evidenceRef = `codex-app-server:${nativeRequestId}`;
  const path = socketPath();
  if (!path)
    return {
      outcome: "failed",
      native_request_id: nativeRequestId,
      model: input.model,
      thinking: input.thinking,
      evidence_ref: `${evidenceRef}:unavailable`,
      error: "Codex app-server control socket is unavailable",
    };
  let socket: Socket | undefined;
  let createdThreadId: string | undefined;
  let creationRequested = false;
  let explicitlyRejected = false;
  try {
    const connected = await connectSocket(path);
    socket = connected.socket;
    const buffer = { value: connected.buffer };
    const initialized = await rpc(socket, buffer, 1, "initialize", {
      clientInfo: { name: "multi-task-flow", version: "1" },
      capabilities: {},
    });
    if (initialized.error)
      throw new Error("Codex app-server initialization failed");
    creationRequested = true;
    const started = await rpc(socket, buffer, nativeRequestId, "thread/start", {
      cwd: process.cwd(),
      ephemeral: false,
      model: input.model,
      config: { model_reasoning_effort: input.thinking },
      threadSource: "multi-task-flow",
    });
    if (started.error) {
      explicitlyRejected = true;
      throw new Error(
        String(record(started.error)?.message ?? "thread/start rejected"),
      );
    }
    const result = record(started.result);
    const thread = record(result?.thread);
    const threadId =
      typeof thread?.id === "string"
        ? thread.id
        : typeof result?.threadId === "string"
          ? result.threadId
          : null;
    if (!threadId) throw new Error("thread/start returned no thread ID");
    createdThreadId = threadId;
    const named = await rpc(socket, buffer, 4, "thread/name/set", {
      threadId,
      name: input.title,
    });
    if (named.error)
      throw new Error(
        String(record(named.error)?.message ?? "thread/name/set rejected"),
      );
    const actualModel =
      typeof result?.model === "string"
        ? result.model
        : typeof thread?.model === "string"
          ? thread.model
          : null;
    const actualThinking =
      typeof result?.reasoningEffort === "string"
        ? result.reasoningEffort
        : typeof thread?.reasoningEffort === "string"
          ? thread.reasoningEffort
          : null;
    if (actualModel !== input.model || actualThinking !== input.thinking)
      throw new Error(
        `thread/start profile mismatch: requested ${input.model}/${input.thinking}, received ${actualModel ?? "unknown"}/${actualThinking ?? "unknown"}`,
      );
    await startTurnAndWait(
      socket,
      buffer,
      {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        effort: input.thinking,
        clientUserMessageId: nativeRequestId,
      },
      threadId,
    );
    return {
      outcome: "succeeded",
      native_request_id: nativeRequestId,
      thread_id: threadId,
      model: input.model,
      thinking: input.thinking,
      evidence_ref: evidenceRef,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome:
        createdThreadId ||
        (creationRequested && !explicitlyRejected) ||
        message.includes("timed out")
          ? "unknown"
          : "failed",
      ...(createdThreadId ? { thread_id: createdThreadId } : {}),
      native_request_id: nativeRequestId,
      model: input.model,
      thinking: input.thinking,
      evidence_ref: `${evidenceRef}:error`,
      error: message.slice(0, 500),
    };
  } finally {
    socket?.destroy();
  }
}

export async function readCodexCapabilities(): Promise<ProfileCapabilities> {
  const path = socketPath();
  if (!path) throw new Error("Codex app-server control socket is unavailable");
  const connected = await connectSocket(path);
  const socket = connected.socket;
  try {
    const buffer = { value: connected.buffer };
    const init = await rpc(socket, buffer, 1, "initialize", {
      clientInfo: { name: "multi-task-flow", version: "1" },
      capabilities: {},
    });
    if (init.error) throw new Error("Codex app-server initialization failed");
    const capabilities: ProfileCapabilities = [];
    let cursor: string | null = null;
    let requestId = 2;
    do {
      const response = await rpc(socket, buffer, requestId++, "model/list", {
        includeHidden: true,
        limit: 100,
        cursor,
      });
      if (response.error)
        throw new Error(
          String(
            record(response.error)?.message ?? "Model catalog unavailable",
          ),
        );
      const result = record(response.result);
      if (!Array.isArray(result?.data))
        throw new Error("Invalid model catalog");
      for (const raw of result.data) {
        const item = record(raw);
        if (
          typeof item?.model !== "string" ||
          !Array.isArray(item.supportedReasoningEfforts)
        )
          continue;
        capabilities.push({
          model: item.model,
          thinking: item.supportedReasoningEfforts.flatMap((effort) =>
            typeof record(effort)?.reasoningEffort === "string"
              ? [String(record(effort)?.reasoningEffort)]
              : [],
          ),
        });
      }
      cursor =
        typeof result?.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);
    return capabilities;
  } finally {
    socket.destroy();
  }
}

export { observeCodex } from "./codex-observer";
export type { JsonRecord } from "./codex-socket";
