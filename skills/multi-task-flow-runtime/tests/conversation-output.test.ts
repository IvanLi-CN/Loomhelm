import { describe, expect, test } from "bun:test";
import { ConversationOutputs, messageOutput, type ConnectObserver } from "../lib/conversation-output";
import type { JsonRecord } from "../lib/codex-agent-api";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const message = (id: string, text: string, phase = "commentary") => ({ turnId: "turn", item: { type: "agentMessage", id, text, phase } });
function fixture(read: (method: string, params: JsonRecord) => Promise<JsonRecord> = async () => ({ data: [] })) {
  let notify!: (event: JsonRecord) => void;
  let lost!: () => void;
  let closed = 0;
  let connections = 0;
  const connect: ConnectObserver = async (n, c) => { notify = n; lost = c; connections++; return { request: (method, params) => method === "thread/read" ? read(method, params).then(value => ({ ...value, thread: { name: "真实对话标题", ...(value.thread as JsonRecord ?? {}) } })) : read(method, params), close: () => { closed++; c(); } }; };
  const published: unknown[] = [];
  const provider = new ConversationOutputs(s => published.push(s), connect, 20);
  provider.bind([{ id: "a", thread_id: "thread" }, { id: "b", thread_id: "thread" }, { id: "none", thread_id: null }]);
  provider.start();
  return { provider, published, event: (method: string, params: JsonRecord) => notify({ method, params: { threadId: "thread", ...params } }), lost: () => lost(), get connections() { return connections; }, get closed() { return closed; } };
}

describe("conversation output projection", () => {
  test("accepts public commentary/final text only", () => {
    for (const phase of ["commentary", "final_answer"]) expect(messageOutput("thread", message("a", "hello", phase))?.text).toBe("hello");
    for (const type of ["reasoning", "userMessage", "commandExecution", "system"]) expect(messageOutput("thread", { item: { id: "a", type, text: "private" } })).toBeNull();
    expect(messageOutput("thread", message("a", " \n"))).toBeNull();
  });
  test("uses only the actual assistant item timestamp, never the observation time", () => {
    const startedAtMs = Date.parse("2026-11-07T01:02:03Z");
    expect(messageOutput("thread", { ...message("a", "hello"), startedAtMs })?.sent_at).toBe("2026-11-07T01:02:03.000Z");
    expect(messageOutput("thread", message("a", "hello"))?.sent_at).toBeNull();
    expect(messageOutput("thread", { ...message("a", "hello"), startedAtMs: Infinity })?.sent_at).toBeNull();
  });
  test("paginates past tools and whitespace, deduplicates bound threads", async () => {
    const calls: JsonRecord[] = [];
    const f = fixture(async (_m, params) => { if (_m === "thread/read") return {}; calls.push(params); return params.cursor ? { data: [message("latest", "progress"), message("older", "old")] } : { data: [message("blank", " "), { item: { type: "reasoning", text: "hidden" } }], nextCursor: "page2" }; });
    try {
      await tick();
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ sortDirection: "desc", threadId: "thread" });
      const s = f.provider.snapshot();
      expect(s.outputs.a?.text).toBe("progress"); expect(s.outputs.b).toEqual(s.outputs.a);
      expect(s.outputs.none?.state).toBe("no_conversation");
    } finally { f.provider.stop(); }
  });
  test("history without a completion timestamp accepts later deltas for the same item", async () => {
    for (const completion of [{}, { completedAtMs: null }]) {
      const f = fixture(async () => ({ data: [{ ...message("live", "partial"), ...completion }] }));
      try {
        await tick();
        expect(f.provider.snapshot().outputs.a?.message_status).toBe("in_progress");
        f.event("item/agentMessage/delta", { turnId: "turn", itemId: "live", delta: " continued" });
        expect(f.provider.snapshot().outputs.a?.text).toBe("partial continued");
        expect(f.provider.receivedDelta).toBe(true);
        f.event("item/completed", message("live", "complete", "final_answer"));
        f.event("item/agentMessage/delta", { turnId: "turn", itemId: "live", delta: " late" });
        expect(f.provider.snapshot().outputs.a).toMatchObject({ text: "complete", message_status: "completed" });
      } finally { f.provider.stop(); }
    }
    expect(messageOutput("thread", { ...message("saved", "final"), completedAtMs: 0 })?.message_status).toBe("completed");
  });
  test("marks a confirmed completed turn as agent idle", async () => {
    const f = fixture(async (method) => method === "thread/read" ? { thread: { status: { type: "idle" } } } : method === "thread/turns/list" ? { data: [{ id: "latest-turn", status: "completed", items: [] }] } : { data: [{ ...message("done", "finished"), completedAtMs: 1 }] });
    try { await tick(); expect(f.provider.snapshot().outputs.a?.agent_state).toBe("idle");
        expect(f.provider.snapshot().outputs.a?.runtime_turn_id).toBe("latest-turn");
        expect(f.provider.snapshot().outputs.a?.observed_at).toBeTruthy(); } finally { f.provider.stop(); }
  });
  test("idle requires the latest terminated turn, independently of older public text", async () => {
    for (const latest of [null, { id: "latest", status: "inProgress" }, { status: "completed" }, { id: "latest", status: "unknown" }, ...["completed", "failed", "interrupted"].map(status => ({ id: "latest", status }))]) {
      const f = fixture(async method => method === "thread/read" ? { thread: { status: { type: "idle" } } } : method === "thread/turns/list" ? { data: latest ? [latest] : [] } : { data: [{ ...message("old", "older public text"), completedAtMs: 1 }] });
      try {
        await tick();
        const output = f.provider.snapshot().outputs.a!;
        const expected = latest?.id && ["completed", "failed", "interrupted"].includes(latest.status!) ? "idle" : latest?.id && ["inProgress", "started", "running"].includes(latest.status!) ? "active" : "unknown";
        expect(output.agent_state).toBe(expected);
        expect(output.runtime_turn_id).toBe(output.agent_state === "idle" || output.agent_state === "active" ? "latest" : null);
        expect(output.turn_id).toBe("turn");
      } finally { f.provider.stop(); }
    }
    const f = fixture();
    try { await tick(); f.event("thread/status/changed", { status: { type: "idle" } }); expect(f.provider.snapshot().outputs.a?.agent_state).toBe("unknown"); } finally { f.provider.stop(); }
  });
  test("terminal turn events expose idle; obsolete turns and unknown runtime do not", async () => {
    for (const status of ["completed", "interrupted", "failed"]) {
      const f = fixture();
      try {
        await tick();
        f.event("turn/started", { turn: { id: "new", status: "inProgress" } });
        expect(f.provider.snapshot().outputs.a?.agent_state).toBe("active");
        f.event("turn/completed", { turn: { id: "old", status } });
        expect(f.provider.snapshot().outputs.a?.agent_state).toBe("active");
        f.event("turn/completed", { turn: { id: "new", status } });
        expect(f.provider.snapshot().outputs.a?.agent_state).toBe("idle");
        f.event("thread/status/changed", { status: { type: "notLoaded" } });
        expect(f.provider.snapshot().outputs.a?.agent_state).toBe("unknown");
        f.lost();
        expect(f.provider.snapshot().outputs.a?.stale).toBe(true);
      } finally { f.provider.stop(); }
    }
  });
  test("completed public messages do not prove an idle runtime", async () => {
    for (const type of ["active", "notLoaded", "systemError"]) {
      const f = fixture(async method => method === "thread/read" ? { thread: { status: { type } } } : { data: [{ ...message("done", "final"), completedAtMs: 1 }] });
      try { await tick(); expect(f.provider.snapshot().outputs.a?.agent_state).toBe(type === "active" ? "active" : "unknown"); } finally { f.provider.stop(); }
    }
  });
  test("confirms idle for an unloaded thread with a terminal latest turn", async () => {
    const f = fixture(async method => method === "thread/read"
      ? { thread: { status: { type: "notLoaded" } } }
      : method === "thread/turns/list"
        ? { data: [{ id: "latest-turn", status: "completed", items: [] }] }
        : { data: [{ ...message("done", "final"), completedAtMs: 1 }] });
    try {
      await tick();
      expect(f.provider.snapshot().outputs.a).toMatchObject({ agent_state: "idle", runtime_turn_id: "latest-turn" });
    } finally { f.provider.stop(); }
  });
  test("confirms active for an unloaded thread with an in-progress latest turn", async () => {
    const f = fixture(async method => method === "thread/read"
      ? { thread: { status: { type: "notLoaded" } } }
      : method === "thread/turns/list"
        ? { data: [{ id: "active-turn", status: "inProgress", items: [] }] }
        : { data: [{ ...message("old", "old final"), completedAtMs: 1 }] });
    try {
      await tick();
      expect(f.provider.snapshot().outputs.a).toMatchObject({ agent_state: "active", runtime_turn_id: "active-turn" });
    } finally { f.provider.stop(); }
  });
  test("does not let an unloaded history read overwrite a later active status", async () => {
    const f = fixture(async method => method === "thread/read"
      ? { thread: { status: { type: "notLoaded" } } }
      : method === "thread/turns/list"
        ? { data: [{ id: "old-turn", status: "completed", items: [] }] }
        : { data: [{ ...message("done", "old final"), completedAtMs: 1 }] });
    try {
      await tick();
      f.event("thread/status/changed", { status: { type: "active" } });
      await tick();
      expect(f.provider.snapshot().outputs.a).toMatchObject({ agent_state: "active", runtime_turn_id: null });
    } finally { f.provider.stop(); }
  });
  test("full turn fallback happens only on an explicit unsupported-method error", async () => {
    const calls: string[] = [];
    const f = fixture(async (method, params) => { if (method === "thread/read") return {}; calls.push(method); if (method === "thread/items/list") throw new Error("method not found"); expect(params.itemsView).toBe("full"); return { data: [{ id: "turn", status: "completed", items: [message("old", "old").item, message("new", "final", "final_answer").item] }] }; });
    try { await tick(); expect(calls).toEqual(["thread/items/list", "thread/turns/list"]); expect(f.provider.snapshot().outputs.a?.text).toBe("final"); } finally { f.provider.stop(); }
  });
  test("streamed text wins over in-flight history; completion replaces deltas and duplicates do not regress", async () => {
    let resolve!: (r: JsonRecord) => void;
    const f = fixture(() => new Promise(r => { resolve = r; }));
    try {
      await tick();
      f.event("item/started", message("live", ""));
      f.event("item/agentMessage/delta", { turnId: "turn", itemId: "live", delta: "working" });
      resolve({ data: [message("old", "old final")] }); await tick();
      expect(f.provider.snapshot().outputs.a).toMatchObject({ text: "working", phase: "commentary", message_status: "in_progress" });
      f.event("item/completed", message("live", "complete", "final_answer"));
      f.event("item/agentMessage/delta", { turnId: "turn", itemId: "live", delta: "duplicate late" });
      f.event("item/started", message("next", "newer"));
      f.event("item/completed", message("live", "complete", "final_answer"));
      expect(f.provider.snapshot().outputs.a?.text).toBe("newer");
      expect(f.provider.receivedDelta).toBe(true);
    } finally { f.provider.stop(); }
  });
  test("rebinding immediately clears text and rejects old requests including remove/re-add", async () => {
    const resolvers: Array<(r: JsonRecord) => void> = [];
    const f = fixture(() => new Promise(r => resolvers.push(r)));
    try {
      await tick();
      f.provider.bind([{ id: "a", thread_id: "replacement" }]);
      expect(f.provider.snapshot().outputs.a).toMatchObject({ thread_id: "replacement", text: null });
      f.provider.bind([{ id: "a", thread_id: "thread" }]);
      resolvers[0]!({ data: [message("old-binding", "must not leak")] }); await tick();
      expect(f.provider.snapshot().outputs.a?.text).toBeNull();
    } finally { f.provider.stop(); resolvers.forEach(r => r({ data: [] })); }
  });
  test("history catch-up updates independently and idle reads do not churn revision", async () => {
    let text = "progress";
    const f = fixture(async () => ({ data: [message(text, text)] }));
    try {
      await tick(); const before = f.provider.snapshot().output_revision;
      await new Promise(r => setTimeout(r, 25)); expect(f.provider.snapshot().output_revision).toBe(before);
      text = "final"; await new Promise(r => setTimeout(r, 25));
      expect(f.provider.snapshot().outputs.a?.text).toBe("final"); expect(f.provider.snapshot().output_revision).toBeGreaterThan(before);
      expect(f.provider.receivedDelta).toBe(false);
    } finally { f.provider.stop(); }
  });
  test("read failure retains successful content with an explicit unavailable marker", async () => {
    let fail = false;
    const f = fixture(async () => { if (fail) throw new Error("access denied"); return { data: [message("a", "saved")] }; });
    try { await tick(); fail = true; await new Promise(r => setTimeout(r, 25)); expect(f.provider.snapshot().outputs.a).toMatchObject({ text: "saved", state: "unavailable", stale: true }); } finally { f.provider.stop(); }
  });
  test("empty conversation differs from read failure and stop closes the observer", async () => {
    const f = fixture(); await tick();
    expect(f.provider.snapshot().outputs.a?.state).toBe("empty");
    f.lost(); expect(f.provider.snapshot().outputs.a?.state).toBe("unavailable");
    f.provider.stop(); const count = f.connections; await tick(); expect(f.connections).toBe(count);
  });
  test("history cannot introduce an unseen older item after native completion", async () => {
    let read = 0;
    const f = fixture(async () => ({ data: read++ ? [message("unseen-old", "old persisted")] : [] }));
    try {
      await tick();
      f.event("item/started", message("live", "partial"));
      f.event("item/completed", message("live", "fresh completed", "final_answer"));
      await new Promise(r => setTimeout(r, 25));
      expect(f.provider.snapshot().outputs.a?.text).toBe("fresh completed");
    } finally { f.provider.stop(); }
  });
  test("unbound thread notifications never enter the snapshot", async () => {
    const f = fixture();
    try { await tick(); f.event("item/completed", { ...message("a", "unrelated"), threadId: "unbound" }); expect(f.provider.snapshot().outputs.a?.state).toBe("empty"); } finally { f.provider.stop(); }
  });
});

test("namespaced task and group bindings share one observer while preserving task aliases", async () => {
  let metadataReads = 0, itemReads = 0;
  const provider = new ConversationOutputs(() => {}, async () => ({ request: async method => { if (method === "thread/read") { metadataReads++; return { thread: { name: "真实主对话" } }; } itemReads++; return { data: [message("latest", "shared reply")] }; }, close() {} }), 10000);
  provider.bind([{ id: "task:same", thread_id: "thread" }, { id: "group:same", thread_id: "thread" }]); provider.start();
  try { await tick(); const outputs = provider.snapshot().outputs; expect(outputs["task:same"]).toEqual(outputs.same); expect(outputs["group:same"]?.text).toBe("shared reply"); expect(outputs["group:same"]?.thread_title).toBe("真实主对话"); expect(metadataReads).toBe(1); expect(itemReads).toBe(1); } finally { provider.stop(); }
});

test("pending title metadata never delays latest message catch-up", async () => {
  let finish!: (value: JsonRecord) => void;
  const provider = new ConversationOutputs(() => {}, async () => ({ request: async method => method === "thread/read" ? new Promise<JsonRecord>(resolve => { finish = resolve; }) : { data: [message("latest", "message without title")] }, close() {} }), 10000);
  provider.bind([{ id: "a", thread_id: "thread" }]); provider.start();
  try { await tick(); expect(provider.snapshot().outputs.a?.text).toBe("message without title"); provider.stop(); finish({ thread: { name: "late title" } }); await tick(); expect(provider.snapshot().outputs.a?.thread_title).toBeNull(); } finally { provider.stop(); }
});
