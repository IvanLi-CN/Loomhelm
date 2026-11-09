import { createConnection, type Socket } from "node:net";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { record, type JsonRecord } from "../lib/codex-socket";
import { DesktopOutputState } from "../lib/desktop-output-state";

type Following = {
  owner: string;
  state: DesktopOutputState;
  last: { id: string; text: string; complete: boolean } | null;
};
/** Version-pinned desktop follower. No execution/control request is exposed. */
export class CodexDesktopFollower {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private client: string | null = null;
  private wanted = new Map<string, object>();
  private following = new Map<string, Following>();
  private pending = new Map<
    string,
    { thread: string; binding: object; at: number }
  >();
  private closed = false;
  constructor(
    path: string,
    private notify: (event: JsonRecord) => void,
    private failed: () => void,
  ) {
    this.socket = createConnection(path);
    this.socket.on("connect", () =>
      this.send({
        type: "request",
        method: "initialize",
        params: { clientType: "multi-task-flow-observer" },
        version: 1,
        requestId: "initialize",
      }),
    );
    this.socket.on("data", (chunk: Buffer) => {
      try {
        this.consume(chunk);
      } catch {
        this.fail();
      }
    });
    this.socket.on("error", () => this.fail());
    this.socket.on("close", () => this.fail());
  }
  static availablePath(): string | null {
    const path = join(
      process.env.CODEX_HOME?.trim() || homedir() + "/.codex",
      "ipc",
      "ipc.sock",
    );
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    return stat.isSocket() &&
      (process.getuid?.() === undefined || stat.uid === process.getuid?.())
      ? path
      : null;
  }
  owns(thread: unknown): boolean {
    return typeof thread === "string" && this.following.has(thread);
  }
  retain(threads: Iterable<string>): void {
    this.wanted = new Map(
      [...threads].map((t) => [t, this.wanted.get(t) ?? {}]),
    );
    for (const [thread, entry] of this.following)
      if (!this.wanted.has(thread)) {
        this.follow(thread, entry.owner, false);
        this.following.delete(thread);
      }
  }
  async ensure(thread: string): Promise<void> {
    const binding = this.wanted.get(thread);
    if (!binding || !this.client || this.following.has(thread) || this.closed)
      return;
    for (const [id, p] of this.pending) {
      if (Date.now() - p.at > 10000) this.pending.delete(id);
      else if (p.thread === thread && p.binding === binding) return;
    }
    const id = randomUUID();
    this.pending.set(id, { thread, binding, at: Date.now() });
    this.send({
      type: "request",
      method: "thread-owner-discovery",
      version: 1,
      requestId: id,
      sourceClientId: this.client,
      params: { conversationId: thread, hostId: "local" },
      timeoutMs: 5000,
    });
  }
  close(): void {
    if (this.closed) return;
    for (const [thread, entry] of this.following)
      this.follow(thread, entry.owner, false);
    this.closed = true;
    this.wanted.clear();
    this.following.clear();
    this.pending.clear();
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 500);
    timer.unref();
  }
  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.following.clear();
    this.pending.clear();
    this.failed();
  }
  private send(value: JsonRecord): void {
    if (this.closed || !this.socket.writable) return;
    const bytes = Buffer.from(JSON.stringify(value));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(bytes.length);
    this.socket.write(Buffer.concat([prefix, bytes]));
  }
  private follow(thread: string, owner: string, following: boolean): void {
    this.send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: this.client,
      targetClientIds: [owner],
      params: { conversationId: thread, hostId: "local", following },
    });
  }
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (!size || size > 64 * 1024 * 1024)
        throw new Error("Invalid desktop frame");
      if (this.buffer.length < size + 4) return;
      const message = record(
        JSON.parse(this.buffer.subarray(4, size + 4).toString()),
      );
      this.buffer = this.buffer.subarray(size + 4);
      if (message) this.message(message);
    }
  }
  private message(message: JsonRecord): void {
    if (message.type === "client-discovery-request") {
      this.send({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (message.type === "response") {
      if (message.requestId === "initialize") {
        const id = record(message.result)?.clientId;
        if (message.resultType !== "success" || typeof id !== "string")
          throw new Error("Desktop initialization rejected");
        this.client = id;
        for (const thread of this.wanted.keys()) void this.ensure(thread);
        return;
      }
      const id = String(message.requestId),
        pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (this.wanted.get(pending.thread) !== pending.binding) return;
      if (
        message.resultType === "success" &&
        message.method === "thread-owner-discovery" &&
        typeof message.handledByClientId === "string"
      ) {
        const owner = message.handledByClientId;
        this.following.set(pending.thread, {
          owner,
          state: new DesktopOutputState(),
          last: null,
        });
        this.follow(pending.thread, owner, true);
      }
      return;
    }
    if (message.type !== "broadcast") return;
    const params = record(message.params);
    if (
      message.method === "client-status-changed" &&
      params?.status === "disconnected"
    ) {
      for (const [thread, entry] of this.following)
        if (entry.owner === params.clientId) this.following.delete(thread);
      return;
    }
    if (
      message.method !== "thread-stream-state-changed" ||
      params?.hostId !== "local" ||
      typeof params.conversationId !== "string"
    )
      return;
    const thread = params.conversationId,
      entry = this.following.get(thread);
    if (
      !entry ||
      entry.owner !== message.sourceClientId ||
      !this.wanted.has(thread)
    )
      return;
    if (message.version !== 11)
      throw new Error("Unsupported desktop stream version");
    const change = record(params.change);
    if (!change) return;
    let selected;
    try {
      selected = entry.state.update(change);
    } catch {
      // A new following registration requests a fresh snapshot; never apply a gap.
      this.follow(thread, entry.owner, false);
      this.following.delete(thread);
      void this.ensure(thread);
      return;
    }
    if (!selected) return;
    const item = selected.item,
      id = String(item.id),
      text = String(item.text),
      prior = entry.last;
    if (
      prior?.id === id &&
      prior.text === text &&
      prior.complete === selected.complete
    )
      return;
    const envelope = { threadId: thread, turnId: selected.turnId, item };
    if (
      change.type === "patches" &&
      !selected.complete &&
      (!prior || prior.id !== id || text.startsWith(prior.text))
    ) {
      if (prior?.id !== id)
        this.notify({
          method: "item/started",
          params: { ...envelope, item: { ...item, text: "" } },
        });
      const delta = prior?.id === id ? text.slice(prior.text.length) : text;
      if (delta)
        this.notify({
          method: "item/agentMessage/delta",
          params: {
            threadId: thread,
            turnId: selected.turnId,
            itemId: id,
            delta,
          },
        });
    } else
      this.notify({
        method: selected.complete ? "item/completed" : "item/started",
        params: envelope,
      });
    entry.last = { id, text, complete: selected.complete };
  }
}
