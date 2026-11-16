import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CliRun,
  createCliThread,
  INITIALIZATION_PROMPT,
  initializationPrompt,
  readThreadEvidence,
  reconcileCliThread,
  runInitialization,
  verifyInitializationTurn,
  verifyRepositoryIdentity,
} from "../lib/codex-cli-create";
import { rpc, websocketFrame } from "../lib/codex-rpc";

const input = {
  title: "test",
  prompt: "DO NOT EXECUTE THIS TASK",
  cwd: process.cwd(),
  model: "gpt-6.1-sol",
  thinking: "max",
};
const completed: CliRun = {
  thread_id: "thread-a",
  exit_code: 0,
  turn_completed: true,
  events: ["thread.started", "turn.completed"],
};
const handshakeTurn = (
  status: string,
  role: "Delivery Agent" | "Task Agent" = "Delivery Agent",
  extraItems: Record<string, unknown>[] = [],
) => ({
  id: "turn-a",
  status,
  items: [
    {
      type: "userMessage",
      content: [{ type: "text", text: initializationPrompt(role) }],
    },
    { type: "agentMessage", text: "已进入待命状态。", phase: "commentary" },
    ...extraItems,
  ],
});
const thread = async () => ({
  id: "thread-a",
  cwd: "/codex/owned",
  model: input.model,
  reasoningEffort: input.thinking,
});
const read = async () => ({
  thread: await thread(),
  turn: handshakeTurn("completed", "Task Agent"),
});

test("app-server RPC drains coalesced frames after the matching response", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: (value: Buffer) => void;
  };
  socket.write = () => {
    queueMicrotask(() =>
      socket.emit(
        "data",
        Buffer.concat([
          websocketFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
          websocketFrame(JSON.stringify({ method: "turn/updated", params: {} })),
        ]),
      ),
    );
  };
  const buffer = { value: Buffer.alloc(0) };
  await expect(rpc(socket as any, buffer, 1, "thread/read", {})).resolves.toMatchObject({
    result: { ok: true },
  });
  expect(buffer.value).toHaveLength(0);
});

test("initialization prompt gives the creation phase enough context without authorizing work", () => {
  expect(INITIALIZATION_PROMPT).toContain("Task Agent");
  expect(initializationPrompt("Delivery Agent")).toContain("Delivery Agent");
  expect(INITIALIZATION_PROMPT).toContain("主 Agent 稍后会发送正式派发消息");
  expect(INITIALIZATION_PROMPT).toContain("不要开始正式任务");
  expect(INITIALIZATION_PROMPT).not.toContain("初始化完成");
  expect(INITIALIZATION_PROMPT).not.toContain("请简短回复");
});

test("startup diagnostics do not count as initialization work", () => {
  expect(() =>
    verifyInitializationTurn(
      {
        ...handshakeTurn("completed", "Delivery Agent"),
        items: [
          { type: "error", message: "deprecated configuration" },
          ...handshakeTurn("completed", "Delivery Agent").items,
        ],
      },
      "Delivery Agent",
    ),
  ).not.toThrow();
});

test("bind requires both process exit and initialization completion, preserving identity on every ambiguous result", async () => {
  for (const result of [
    { ...completed, exit_code: 1 },
    { ...completed, exit_code: null },
    { ...completed, turn_completed: false },
    { ...completed, error: "timeout" },
  ]) {
    let reads = 0;
    const receipt = await createCliThread(input, {
      run: async () => result,
      read: async () => {
        reads++;
        return read();
      },
      verify: () => "a".repeat(40),
    });
    expect(receipt.outcome).toBe("unknown");
    expect(receipt.thread_id).toBe("thread-a");
    expect(reads).toBe(0);
  }
});
test("actual profile and Codex ownership are required; initial HEAD is separate from baseline", async () => {
  const deps = { run: async () => completed, read, verify: () => "a".repeat(40) };
  const success = await createCliThread(input, deps);
  expect(success.outcome).toBe("succeeded");
  expect(success.initial_head).toBe("a".repeat(40));
  expect(success).not.toHaveProperty("development_baseline");
  expect(success.initialization_turn_id).toBe("turn-a");
  expect(
    (
      await createCliThread(input, {
        ...deps,
        read: async () => ({
          thread: { ...(await thread()), model: "other" },
          turn: handshakeTurn("completed", "Task Agent"),
        }),
      })
    ).outcome,
  ).toBe("unknown");
  expect(
    (
      await createCliThread(input, {
        ...deps,
        read: async () => ({
          thread: await thread(),
          turn: handshakeTurn("completed", "Task Agent", [{ type: "futureToolCall" }]),
        }),
      })
    ).outcome,
  ).toBe("unknown");
  expect(
    (
      await createCliThread(input, {
        ...deps,
        verify: () => {
          throw new Error("ownership mismatch");
        },
      })
    ).outcome,
  ).toBe("unknown");
});

test("malformed handshake evidence remains unreconcilable", () => {
  expect(() =>
    verifyInitializationTurn({
      ...handshakeTurn("completed", "Task Agent"),
      items: [...handshakeTurn("completed", "Task Agent").items, "commandExecution"],
    }),
  ).toThrow("malformed");
  expect(() =>
    verifyInitializationTurn({
      ...handshakeTurn("completed", "Task Agent"),
      items: [
        {
          type: "userMessage",
          content: [
            { type: "text", text: initializationPrompt("Task Agent") },
            { type: "futureContent" },
          ],
        },
        handshakeTurn("completed", "Task Agent").items[1],
      ],
    }),
  ).toThrow("content is malformed");
});

test("reconciliation requires the matching completed handshake before checking the worktree", async () => {
  const verified: string[][] = [];
  const result = await reconcileCliThread(
    {
      thread_id: "thread-a",
      model: input.model,
      thinking: input.thinking,
      source_cwd: input.cwd,
      role: "Delivery Agent",
    },
    {
      read: async () => ({
        thread: await thread(),
        turn: handshakeTurn("completed"),
      }),
      verify: (...args) => {
        verified.push(args);
        return "b".repeat(40);
      },
    },
  );
  expect(result).toMatchObject({
    thread_id: "thread-a",
    workspace_path: "/codex/owned",
    initial_head: "b".repeat(40),
    turn_completed: true,
  });
  expect(verified).toEqual([["/codex/owned", input.cwd, "thread-a"]]);
});

test("reconciliation hydrates handshake items separately from the turn summary", async () => {
  const calls: string[] = [];
  const request = async (_socket: any, _buffer: any, _id: number, method: string) => {
    calls.push(method);
    if (method === "thread/read") return { result: { thread: await thread() } };
    if (method === "thread/turns/list")
      return { result: { data: [{ id: "turn-a", status: "completed", items: [] }] } };
    return {
      result: {
        data: [
          {
            turnId: "turn-a",
            item: {
              type: "userMessage",
              content: [{ type: "text", text: initializationPrompt("Task Agent") }],
            },
          },
          { turnId: "turn-a", item: { type: "agentMessage", text: "待命。" } },
        ],
      },
    };
  };
  const evidence = await readThreadEvidence(
    {} as any,
    { value: Buffer.alloc(0) },
    "thread-a",
    2,
    request,
  );
  expect(() => verifyInitializationTurn(evidence.turn, "Task Agent")).not.toThrow();
  expect(calls).toEqual(["thread/read", "thread/turns/list", "thread/items/list"]);
});

test("interrupted or workful initialization remains unreconcilable", async () => {
  expect(() => verifyInitializationTurn(handshakeTurn("interrupted"), "Delivery Agent")).toThrow(
    "not completed",
  );
  expect(() =>
    verifyInitializationTurn(handshakeTurn("completed", "Task Agent"), "Delivery Agent"),
  ).toThrow("expected agent role");
  expect(() =>
    verifyInitializationTurn(
      handshakeTurn("completed", "Delivery Agent", [
        { type: "commandExecution", command: "git status", status: "completed" },
      ]),
      "Delivery Agent",
    ),
  ).toThrow("recorded work");
  for (const type of [
    "collabAgentToolCall",
    "functionCallOutput",
    "subAgentActivity",
    "imageGeneration",
    "imageView",
    "sleep",
    "futureToolCall",
  ])
    expect(() =>
      verifyInitializationTurn(
        handshakeTurn("completed", "Delivery Agent", [{ type }]),
        "Delivery Agent",
      ),
    ).toThrow("recorded work");
  await expect(
    reconcileCliThread(
      {
        thread_id: "thread-a",
        model: input.model,
        thinking: input.thinking,
        source_cwd: input.cwd,
        role: "Delivery Agent",
      },
      {
        read: async () => ({
          thread: await thread(),
          turn: handshakeTurn("interrupted"),
        }),
        verify: () => {
          throw new Error("worktree must not be inspected for an incomplete turn");
        },
      },
    ),
  ).rejects.toThrow("not completed");
});
test("repository identity is checked before starting the external CLI", async () => {
  expect(() =>
    verifyRepositoryIdentity(input.cwd, { host: "github.com", owner: "other", name: "repo" }),
  ).toThrow("Repository identity");
  let started = false;
  const receipt = await createCliThread(
    { ...input, repository: { host: "github.com", owner: "other", name: "repo" } },
    {
      run: async () => {
        started = true;
        return completed;
      },
      read,
      verify: () => "a".repeat(40),
    },
  );
  expect(receipt.outcome).toBe("unknown");
  expect(started).toBe(false);
});
test("real subprocess receives literal argv and EOF, never the formal prompt; thread identity persists before exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-adapter-"));
  const oldPath = process.env.PATH;
  try {
    const executable = join(root, "codex"),
      capture = join(root, "argv.json");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),nativeRequestId:process.env.MULTI_TASK_FLOW_NATIVE_REQUEST_ID}));process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'real-event'}));setTimeout(()=>console.log(JSON.stringify({type:'turn.completed'})),30)});process.stdin.resume();`,
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${root}:${oldPath}`;
    const observed: string[] = [];
    const result = await runInitialization({
      ...input,
      native_request_id: "native-test",
      onThreadStarted: (id) => observed.push(id),
    });
    expect(result.exit_code).toBe(0);
    expect(result.turn_completed).toBe(true);
    expect(observed).toEqual(["real-event"]);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
      argv: [
        "exec",
        "-C",
        input.cwd,
        "--worktree",
        "--json",
        "-m",
        input.model,
        "-c",
        'model_reasoning_effort="max"',
        INITIALIZATION_PROMPT,
      ],
      nativeRequestId: "native-test",
    });
    const delivery = await runInitialization({ ...input, role: "Delivery Agent" });
    expect(delivery.exit_code).toBe(0);
    expect(JSON.parse(readFileSync(capture, "utf8")).argv.at(-1)).toBe(
      initializationPrompt("Delivery Agent"),
    );
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'partial'}));console.log(JSON.stringify({type:'item.started',item:{type:'commandExecution'}}));setInterval(()=>{},1000);`,
    );
    const failed = await runInitialization(input);
    expect(failed.thread_id).toBe("partial");
    expect(failed.error).toContain("attempted work");
    expect(failed.exit_code).not.toBe(0);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test("aborting initialization terminates tool descendants and closes inherited pipes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-descendants-"));
  const oldPath = process.env.PATH;
  let pid: number | undefined;
  try {
    const executable = join(root, "codex"),
      pidFile = join(root, "descendant.pid"),
      heartbeat = join(root, "heartbeat");
    const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(heartbeat)},'x');console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),10);`;
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');console.log(JSON.stringify({type:'thread.started',thread_id:'descendant-test'}));spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000);`,
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${root}:${oldPath}`;
    const result = await runInitialization(input);
    pid = Number(readFileSync(pidFile, "utf8"));
    expect(result.thread_id).toBe("descendant-test");
    expect(result.error).toContain("attempted work");
    expect(result.exit_code).not.toBe(0);
    const before = readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(readFileSync(heartbeat, "utf8")).toBe(before);
  } finally {
    // Only this test's recorded subprocess; the supervisor normally reaps it.
    if (pid) {
      try {
        const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (command.includes(root)) process.kill(pid, "SIGKILL");
      } catch {}
    }
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
