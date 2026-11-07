import { createServer } from "node:net";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { PortRegistry } from "../../bin/modules/workspace/port_registry";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import { LedgerStore } from "../scripts/store";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = listener.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolvePromise, reject) => {
    listener.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error("serve.ts exited before announcing its URL");
      output += decoder.decode(chunk.value, { stream: true });
      const newline = output.indexOf("\n");
      if (newline >= 0) return output.slice(0, newline);
    }
  } finally {
    reader.releaseLock();
  }
}

describe("multi-task dashboard service wrapper", () => {
  test("records its pid/session and releases its lease on SIGTERM", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "multi-task-serve-"),
    );
    const dataRoot = join(root, "data");
    const registryRoot = join(root, "registry");
    const repoRoot = resolve(import.meta.dir, "../../..");
    const run = createDemoLedger();
    const runStore = new LedgerStore(dataRoot, run.orchestration_id);
    const viewRoot = join(runStore.runPath, "view");
    const port = await freePort();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let duplicate: ReturnType<typeof Bun.spawn> | undefined;
    try {
      runStore.create(run);
      await mkdir(viewRoot, { recursive: true });
      await writeFile(
        join(viewRoot, "index.html"),
        "<!doctype html><title>test</title>",
      );
      await writeFile(join(viewRoot, "app.js"), "");
      await writeFile(join(viewRoot, "app.css"), "");

      const registry = new PortRegistry(registryRoot);
      await registry.register({
        scopeId: "scope-test",
        service: "dashboard",
        port,
        project: "test",
        repoRoot,
        branch: "test",
        worktreePath: repoRoot,
      });

      child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/serve.ts"),
          "--run",
          run.orchestration_id,
          "--scope-id",
          "scope-test",
          "--service",
          "dashboard",
          "--port",
          String(port),
          "--agent-session",
          "native-session-test",
          "--custom-view",
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CODEX_HOME: repoRoot,
            CODEX_PORT_REGISTRY_DIR: registryRoot,
            TASK_ORCHESTRATION_DATA_ROOT: dataRoot,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const stdout = child.stdout;
      if (stdout === undefined || typeof stdout === "number")
        throw new Error("serve.ts stdout is not piped");
      const announcement = JSON.parse(await readLine(stdout));
      expect(announcement).toMatchObject({
        ok: true,
        port,
        scope_id: "scope-test",
        service: "dashboard",
        agent_session_recorded: true,
      });

      const runningRows = await registry.readRows();
      expect(runningRows).toHaveLength(1);
      expect(runningRows[0]).toMatchObject({
        scope_id: "scope-test",
        service: "dashboard",
        port: String(port),
        agent_session: "native-session-test",
        pid: String(child.pid),
      });

      duplicate = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/serve.ts"),
          "--run",
          run.orchestration_id,
          "--scope-id",
          "scope-test",
          "--service",
          "dashboard",
          "--port",
          String(port),
          "--agent-session",
          "native-session-test-duplicate",
          "--custom-view",
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CODEX_HOME: repoRoot,
            CODEX_PORT_REGISTRY_DIR: registryRoot,
            TASK_ORCHESTRATION_DATA_ROOT: dataRoot,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const duplicateExit = await duplicate.exited;
      const duplicateStderr = duplicate.stderr;
      const duplicateOutput =
        duplicateStderr === undefined || typeof duplicateStderr === "number"
          ? ""
          : await new Response(duplicateStderr).text();
      duplicate = undefined;
      expect(duplicateExit).toBe(5);
      expect(duplicateOutput).toContain('"code":"LEASE_UNAVAILABLE"');
      expect(await registry.readRows()).toEqual(runningRows);

      process.kill(child.pid, "SIGTERM");
      const stderr = child.stderr;
      const exitCode = await child.exited;
      child = undefined;
      if (exitCode !== 0 && stderr !== undefined && typeof stderr !== "number")
        throw new Error(
          `serve.ts exited with ${exitCode}: ${await new Response(stderr).text()}`,
        );
      expect(exitCode).toBe(0);
      expect(await registry.readRows()).toHaveLength(0);
    } finally {
      if (duplicate) {
        try {
          process.kill(duplicate.pid, "SIGKILL");
        } catch {}
        await duplicate.exited;
      }
      if (child) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {}
        await child.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
