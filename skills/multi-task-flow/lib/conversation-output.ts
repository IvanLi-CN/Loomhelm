import { messageSentAt } from "../lib/conversation-history";
import { latestConversationOutput } from "../lib/conversation-history";
export { messageOutput } from "../lib/conversation-history";
import { randomUUID } from "node:crypto";
import { observeCodex, type JsonRecord } from "../lib/codex-agent-api";
import {
  initialOutput,
  type AgentOutput,
  type OutputSnapshot,
} from "../web/agent-output";

type Binding = { id: string; thread_id: string | null };
type NativeConnection = Awaited<ReturnType<typeof observeCodex>>;
type Connection = Pick<NativeConnection, "request" | "close"> &
  Partial<Pick<NativeConnection, "subscriptions">>;
export type ConnectObserver = (
  notify: (value: JsonRecord) => void,
  close: () => void,
) => Promise<Connection>;
const object = (v: unknown): JsonRecord | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as JsonRecord)
    : null;
const key = (turn: unknown, item: unknown) => JSON.stringify([turn, item]);

type ThreadState = {
  output: AgentOutput;
  version: number;
  activeTurnId: string | null;
  items: Map<
    string,
    { rank: number; text: string; phase: string | null; done: boolean; sent_at: string | null }
  >;
  rank: number;
  selectedRank: number;
  streamGeneration: number;
  reading: boolean;
  failures: number;
  retryAt: number;
};
/** Latest output is ephemeral and independent of ledger revision. */
export class ConversationOutputs {
  private titles = new Map<string, string | null>();
  private titleReads = new Set<string>();
  private titleReadAt = new Map<string, number>();
  private bindings = new Map<string, string | null>();
  private threads = new Map<string, ThreadState>();
  private connection: Connection | null = null;
  private generation = 0;
  private revision = 0;
  private readonly epoch = randomUUID();
  private active = false;
  private opening: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private backoff = 1000;
  receivedDelta = false;
  constructor(
    private publish: (snapshot: OutputSnapshot) => void,
    private connect: ConnectObserver = observeCodex,
    private pollMs = 2000,
  ) {}
  snapshot(): OutputSnapshot {
    return {
      output_epoch: this.epoch,
      output_revision: this.revision,
      outputs: Object.fromEntries(
        [...this.bindings].flatMap(([id, thread]) => { const output = thread ? ({ ...(this.threads.get(thread)?.output ?? initialOutput(thread)), thread_title: this.titles.get(thread) ?? null }) : initialOutput(null); return id.startsWith("task:") ? [[id, output], [id.slice(5), output]] : [[id, output]]; }),
      ),
    };
  }
  bind(tasks: Binding[]): void {
    const next = new Map(tasks.map((t) => [t.id, t.thread_id]));
    const changed =
      JSON.stringify([...next]) !== JSON.stringify([...this.bindings]);
    this.bindings = next;
    const wanted = new Set([...next.values()].filter((t): t is string => !!t));
    this.connection?.subscriptions?.retain(wanted);
    for (const thread of this.threads.keys())
      if (!wanted.has(thread)) { this.threads.delete(thread); this.titles.delete(thread); this.titleReads.delete(thread); this.titleReadAt.delete(thread); }
    for (const thread of wanted)
      if (!this.threads.has(thread)) {
        this.threads.set(thread, {
          output: initialOutput(thread),
          version: 0,
          activeTurnId: null,
          items: new Map(),
          rank: 0,
          selectedRank: 0,
          streamGeneration: -1,
          reading: false,
          failures: 0,
          retryAt: 0,
        });
        if (this.connection)
          void this.load(thread, this.connection, this.generation);
      }
    if (changed) this.changed(true);
    if (!wanted.size && this.active) this.stop();
  }
  start(): void {
    if (!this.active && this.threads.size) {
      this.active = true;
      void this.open();
    }
  }
  stop(): void {
    this.active = false;
    this.generation++;
    this.opening = null;
    clearTimeout(this.timer);
    clearTimeout(this.pollTimer);
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }
  private changed(immediate: boolean): void {
    this.revision++;
    if (immediate) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.publish(this.snapshot());
    } else if (!this.flushTimer)
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.publish(this.snapshot());
      }, 100);
  }
  private set(state: ThreadState, output: AgentOutput, immediate = true): void {
    // No notification or version churn merely because a history read succeeded again.
    const { observed_at: _old, ...old } = state.output;
    const { observed_at: _new, ...next } = output;
    if (JSON.stringify(old) === JSON.stringify(next)) return;
    state.output = output;
    this.changed(immediate);
  }
  private async open(): Promise<void> {
    if (!this.active || this.opening !== null) return;
    const generation = ++this.generation;
    this.opening = generation;
    let lostAlready = false;
    const lost = () => {
      if (generation !== this.generation || !this.active || lostAlready) return;
      lostAlready = true;
      this.connection = null;
      clearTimeout(this.pollTimer);
      for (const state of this.threads.values())
        this.set(state, { ...state.output, state: "unavailable", stale: true, agent_state: "unknown" });
      this.timer = setTimeout(() => void this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    try {
      const connection = await this.connect((e) => {
        if (generation === this.generation && this.active && !lostAlready)
          this.notify(e);
      }, lost);
      if (!this.active || generation !== this.generation || lostAlready) {
        connection.close();
        return;
      }
      this.connection = connection;
      connection.subscriptions?.retain(this.threads.keys());
      void this.catchUp(connection, generation);
    } catch {
      lost();
    } finally {
      if (this.opening === generation) this.opening = null;
    }
  }
  private async catchUp(
    connection: Connection,
    generation: number,
  ): Promise<void> {
    for (const thread of this.threads.keys()) {
      if (
        !this.active ||
        generation !== this.generation ||
        this.connection !== connection
      )
        return;
      await this.load(thread, connection, generation);
    }
    if (
      this.active &&
      generation === this.generation &&
      this.connection === connection
    ) {
      this.backoff = 1000;
      // Historical catch-up is not evidence of native streaming support.
      this.pollTimer = setTimeout(
        () => void this.catchUp(connection, generation),
        this.pollMs,
      );
    }
  }
  private async load(
    thread: string,
    connection: Connection,
    generation: number,
  ): Promise<void> {
    const state = this.threads.get(thread);
    if (!state || state.reading || state.retryAt > Date.now()) return;
    state.reading = true;
    const version = state.version;
    const valid = () =>
      this.active &&
      generation === this.generation &&
      this.connection === connection &&
      this.threads.get(thread) === state &&
      state.version === version;
    try {
      // Runtime metadata and title reads must not hold up public message history.
      const metadataRead = connection.request("thread/read", { threadId: thread, includeTurns: false });
      void metadataRead.then(metadata => {
        if (!valid()) return;
        const title = object(metadata.thread)?.name;
        const next = typeof title === "string" && title.trim() ? title : null;
        if (this.titles.get(thread) !== next) { this.titles.set(thread, next); this.changed(true); }
      }).catch(() => {});
      void (async () => {
        let runtime: "active" | "idle" | "unknown" = "unknown";
        let runtimeTurnId: string | null = null;
        try {
          const metadata = await metadataRead;
          const status = object(object(metadata.thread)?.status)?.type;
          if (status === "active") runtime = "active";
          if (status === "idle") {
            const page = await connection.request("thread/turns/list", { threadId: thread, sortDirection: "desc", limit: 1, itemsView: "full" });
            const latest = Array.isArray(page.data) ? object(page.data[0]) : null;
            if (typeof latest?.id === "string" && latest.id.trim() && ["completed", "interrupted", "failed"].includes(String(latest.status))) {
              runtime = "idle";
              runtimeTurnId = latest.id;
            }
          }
        } catch { /* Runtime observation is independent of readable output history. */ }
        if (!valid()) return;
        state.activeTurnId = runtimeTurnId;
        this.set(state, { ...state.output, agent_state: runtime, runtime_turn_id: runtimeTurnId });
      })();
      await connection.subscriptions?.ensure(thread);
      if (!valid()) return;
      const selected = await latestConversationOutput(thread, connection);
      if (!valid()) return;
      // Never replace a locally streaming item with an older persisted item.
      if (state.streamGeneration === generation) {
        if (selected?.message_id !== state.output.message_id) return;
        if (
          state.output.text &&
          selected.text &&
          selected.text.length < state.output.text.length
        )
          return;
      }
      if (selected) {
        const identity = key(selected.turn_id, selected.message_id);
        const known = state.items.get(identity);
        if (known && known.rank < state.selectedRank) return;
        state.items.set(identity, {
          rank: known?.rank ?? ++state.rank,
          text: selected.text!,
          phase: selected.phase,
          done: selected.message_status === "completed",
          sent_at: selected.sent_at ?? known?.sent_at ?? null,
        });
        state.selectedRank = state.items.get(identity)!.rank;
      }
      state.failures = 0;
      state.retryAt = 0;
      this.set(
        state,
        { ...(selected ?? {
          ...initialOutput(thread),
          state: "empty",
          stale: false,
          observed_at: new Date().toISOString(),
        }), agent_state: state.output.agent_state, runtime_turn_id: state.output.runtime_turn_id },
      );
    } catch {
      if (valid()) {
        state.retryAt =
          Date.now() +
          Math.min(1000 * 2 ** Math.min(state.failures++, 5), 30000);
        this.set(state, { ...state.output, state: "unavailable", stale: true, agent_state: "unknown" });
      }
    } finally {
      state.reading = false;
    }
  }
  private notify(event: JsonRecord): void {
    const params = object(event.params);
    const thread = params?.threadId;
    if (typeof thread !== "string" || !params) return;
    const state = this.threads.get(thread);
    if (!state) return;
    const method = event.method;
    if (method === "thread/status/changed") {
      const status = object(params.status)?.type;
      state.version++;
      state.activeTurnId = null;
      this.set(state, { ...state.output, agent_state: status === "active" ? "active" : "unknown", runtime_turn_id: null, observed_at: new Date().toISOString() });
      if (status === "idle" && this.connection) void this.load(thread, this.connection, this.generation);
      return;
    }
    if (method === "turn/started") {
      state.version++;
      state.activeTurnId = typeof object(params.turn)?.id === "string" ? object(params.turn)!.id as string : null;
      this.set(state, { ...state.output, agent_state: "active", turn_id: typeof object(params.turn)?.id === "string" ? object(params.turn)!.id as string : state.output.turn_id });
      return;
    }
    if (
      ["turn/completed", "turn/failed", "turn/interrupted"].includes(String(method)) &&
      typeof state.activeTurnId === "string" && object(params.turn)?.id === state.activeTurnId
    ) {
      state.version++;
      const turnStatus = object(params.turn)?.status;
      this.set(state, {
        ...state.output,
        runtime_turn_id: object(params.turn)!.id as string,
        message_status: typeof turnStatus === "string" ? turnStatus : "completed",
        agent_state: turnStatus === undefined || ["completed", "failed", "interrupted"].includes(String(turnStatus)) ? "idle" : "unknown",
        observed_at: new Date().toISOString(),
        stale: false,
      });
      return;
    }
    const delta = method === "item/agentMessage/delta";
    const item = object(params.item);
    if (
      !delta &&
      (!["item/started", "item/completed"].includes(String(method)) ||
        item?.type !== "agentMessage")
    )
      return;
    const id = delta ? params.itemId : item?.id;
    if (typeof id !== "string" || typeof params.turnId !== "string") return;
    const identity = key(params.turnId, id);
    let entry = state.items.get(identity);
    if (!entry) {
      entry = { rank: ++state.rank, text: "", phase: null, done: false, sent_at: null };
      state.items.set(identity, entry);
    }
    entry.sent_at = messageSentAt(item?.startedAtMs ?? params.startedAtMs) ?? entry.sent_at;
    state.version++;
    state.streamGeneration = this.generation;
    if (delta) {
      if (typeof params.delta !== "string" || entry.done) return;
      this.receivedDelta = true;
      entry.text += params.delta;
    } else {
      if (method === "item/started" && entry.done) return;
      entry.text = typeof item?.text === "string" ? item.text : entry.text;
      entry.phase = typeof item?.phase === "string" ? item.phase : entry.phase;
      entry.done = method === "item/completed";
    }
    if (!entry.text.trim() || entry.rank < state.selectedRank) return;
    state.selectedRank = entry.rank;
    this.set(
      state,
      {
        state: "available",
        text: entry.text,
        sent_at: entry.sent_at,
        thread_id: thread,
        turn_id: params.turnId,
        message_id: id,
        phase: entry.phase,
        message_status: entry.done ? "completed" : "in_progress",
        agent_state: "active",
        observed_at: new Date().toISOString(),
        stale: false,
      },
      !delta,
    );
  }
}
