import {
  record,
  socketPath,
  connectSocket,
  timeoutMs,
  websocketFrame,
  framePayload,
  parseRpc,
  type JsonRecord,
} from "../lib/codex-socket";
import { CodexDesktopFollower } from "../lib/codex-desktop-follower";
import { LoadedThreadSubscriptions } from "../lib/codex-subscription";
/** Observer connection: read history and rejoin bound, already loaded sessions only. */
export async function observeCodex(
  onNotification: (event: JsonRecord) => void,
  onClose: () => void,
) {
  const path = socketPath();
  if (!path) throw new Error("Codex app-server unavailable");
  const { socket, buffer: initial } = await connectSocket(path);
  let buffer = initial;
  let serial = 0;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nativeSubscriptions: LoadedThreadSubscriptions | undefined;
  let desktop: CodexDesktopFollower | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    nativeSubscriptions?.close();
    desktop?.close();
    socket.destroy();
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Codex observer closed"));
    }
    pending.clear();
    onClose();
  };
  const consume = () => {
    try {
      while (true) {
        const frame = framePayload(buffer);
        if (!frame) break;
        const opcode = buffer[0]! & 15;
        const final = !!(buffer[0]! & 128);
        buffer = buffer.subarray(frame.consumed);
        if (opcode === 8) {
          close();
          return;
        }
        if (opcode === 9) {
          socket.write(websocketFrame(frame.payload, 10));
          continue;
        }
        if (opcode === 10) continue;
        if (opcode !== 1 && opcode !== 0)
          throw new Error("Unsupported WebSocket opcode");
        if (
          (opcode === 1 && fragments.length) ||
          (opcode === 0 && !fragments.length)
        )
          throw new Error("Invalid WebSocket continuation");
        fragments.push(frame.payload);
        fragmentBytes += frame.payload.length;
        if (fragmentBytes > 64 * 1024 * 1024)
          throw new Error("Observer message exceeds limit");
        if (!final) continue;
        const message = parseRpc(Buffer.concat(fragments));
        fragments = [];
        fragmentBytes = 0;
        if (!message) continue;
        const call =
          typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (call) {
          pending.delete(message.id as number);
          clearTimeout(call.timer);
          if (message.error)
            call.reject(
              new Error(
                String(record(message.error)?.message ?? "Codex read rejected"),
              ),
            );
          else call.resolve(record(message.result) ?? {});
        } else if (
          typeof message.method === "string" &&
          !desktop?.owns(record(message.params)?.threadId)
        )
          onNotification(message);
      }
    } catch {
      close();
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    consume();
  });
  socket.on("error", close);
  socket.on("close", close);
  const request = (method: string, params: JsonRecord): Promise<JsonRecord> => {
    if (closed) return Promise.reject(new Error("Codex observer closed"));
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Codex read timed out"));
      }, timeoutMs());
      pending.set(id, { resolve, reject, timer });
      socket.write(
        websocketFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
      );
      consume();
    });
  };
  try {
    await request("initialize", {
      clientInfo: { name: "multi-task-flow-observer", version: "1" },
      capabilities: {},
    });
    socket.write(
      websocketFrame(JSON.stringify({ jsonrpc: "2.0", method: "initialized" })),
    );
    nativeSubscriptions = new LoadedThreadSubscriptions(request);
    const desktopPath = CodexDesktopFollower.availablePath();
    if (desktopPath)
      desktop = new CodexDesktopFollower(desktopPath, onNotification, close);
    const subscriptions = {
      retain(threads: Iterable<string>) {
        const ids = [...threads];
        nativeSubscriptions!.retain(ids);
        desktop?.retain(ids);
      },
      async ensure(thread: string) {
        await nativeSubscriptions!.ensure(thread);
        await desktop?.ensure(thread);
      },
      close() {
        nativeSubscriptions!.close();
        desktop?.close();
      },
    };
    const historyRequest = (method: string, params: JsonRecord) => {
      if (
        !["thread/read", "thread/items/list", "thread/turns/list"].includes(
          method,
        )
      )
        return Promise.reject(new Error("Not a history read method"));
      return request(method, params);
    };
    return { request: historyRequest, close, subscriptions };
  } catch (error) {
    close();
    throw error;
  }
}
