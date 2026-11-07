import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliThread, runInitialization, INITIALIZATION_PROMPT, type CliRun } from "../scripts/codex-cli-create";

const input = { title: "test", prompt: "DO NOT EXECUTE THIS TASK", cwd: process.cwd(), model: "gpt-6.1-sol", thinking: "max" };
const completed: CliRun = { thread_id: "thread-a", exit_code: 0, turn_completed: true, events: ["thread.started", "turn.completed"] };
const read = async () => ({ id: "thread-a", cwd: "/codex/owned", model: input.model, reasoningEffort: input.thinking });

test("bind requires both process exit and initialization completion, preserving identity on every ambiguous result", async () => {
  for (const result of [ { ...completed, exit_code: 1 }, { ...completed, exit_code: null }, { ...completed, turn_completed: false }, { ...completed, error: "timeout" } ]) {
    let reads = 0;
    const receipt = await createCliThread(input, { run: async () => result, read: async () => { reads++; return read(); }, verify: () => "a".repeat(40) });
    expect(receipt.outcome).toBe("unknown"); expect(receipt.thread_id).toBe("thread-a"); expect(reads).toBe(0);
  }
});
test("actual profile and Codex ownership are required; initial HEAD is separate from baseline", async () => {
  const deps = { run: async () => completed, read, verify: () => "a".repeat(40) };
  const success = await createCliThread(input, deps);
  expect(success.outcome).toBe("succeeded"); expect(success.initial_head).toBe("a".repeat(40));
  expect(success).not.toHaveProperty("development_baseline");
  expect((await createCliThread(input, { ...deps, read: async () => ({ ...await read(), model: "other" }) })).outcome).toBe("unknown");
  expect((await createCliThread(input, { ...deps, verify: () => { throw new Error("ownership mismatch"); } })).outcome).toBe("unknown");
});
test("real subprocess receives literal argv and EOF, never the formal prompt; thread identity persists before exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-adapter-"));
  const oldPath = process.env.PATH;
  try {
    const executable = join(root, "codex"), capture = join(root, "argv.json");
    writeFileSync(executable, `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'real-event'}));setTimeout(()=>console.log(JSON.stringify({type:'turn.completed'})),30)});process.stdin.resume();`);
    chmodSync(executable, 0o755); process.env.PATH = `${root}:${oldPath}`;
    const observed: string[] = [];
    const result = await runInitialization({ ...input, onThreadStarted: id => observed.push(id) });
    expect(result.exit_code).toBe(0); expect(result.turn_completed).toBe(true); expect(observed).toEqual(["real-event"]);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(["exec", "-C", input.cwd, "--worktree", "--json", "-m", input.model, "-c", 'model_reasoning_effort="max"', INITIALIZATION_PROMPT]);
    writeFileSync(executable, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'partial'}));console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));setInterval(()=>{},1000);`);
    const failed = await runInitialization(input);
    expect(failed.thread_id).toBe("partial"); expect(failed.error).toContain("attempted work"); expect(failed.exit_code).not.toBe(0);
  } finally { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); }
}, 10000);

test("aborting initialization terminates tool descendants and closes inherited pipes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-descendants-"));
  const oldPath = process.env.PATH;
  let pid: number | undefined;
  try {
    const executable = join(root, "codex"), pidFile = join(root, "descendant.pid"), heartbeat = join(root, "heartbeat");
    const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(heartbeat)},'x');console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),10);`;
    writeFileSync(executable, `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');console.log(JSON.stringify({type:'thread.started',thread_id:'descendant-test'}));spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000);`);
    chmodSync(executable, 0o755); process.env.PATH = `${root}:${oldPath}`;
    const result = await runInitialization(input);
    pid = Number(readFileSync(pidFile, "utf8"));
    expect(result.thread_id).toBe("descendant-test");
    expect(result.error).toContain("attempted work");
    expect(result.exit_code).not.toBe(0);
    const before = readFileSync(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(readFileSync(heartbeat, "utf8")).toBe(before);
  } finally {
    // Only this test's recorded subprocess; the supervisor normally reaps it.
    if (pid) { try {
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (command.includes(root)) process.kill(pid, "SIGKILL");
    } catch {} }
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
