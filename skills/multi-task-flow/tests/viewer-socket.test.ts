import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startUnixViewerWorkerServer,
  viewerWorkerSocketPath,
} from "../scripts/viewer-socket";
import { createUnixViewerWorker } from "../scripts/viewer-worker";
import { createWorkerGeneration } from "../scripts/viewer-runtime";

const roots: string[] = [];
const servers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Unix worker transport preserves streaming responses and immutable identity", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "viewer-socket-")));
  roots.push(root);
  const workerKey = "schema-2/contract-2@release-a";
  const generation = createWorkerGeneration();
  const socketPath = viewerWorkerSocketPath(root, workerKey, generation);
  const server = await startUnixViewerWorkerServer({
    socketPath,
    workerKey,
    generation,
    handle: async (request, context) => {
      expect(request.url).toBe("http://viewer.test/runs/demo/events");
      expect(context).toMatchObject({ runId: "demo", workerKey, generation });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: one\n\n"));
            controller.enqueue(new TextEncoder().encode("event: two\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  servers.push(server);
  expect(lstatSync(socketPath).isSocket()).toBe(true);
  expect(lstatSync(socketPath).mode & 0o077).toBe(0);

  const worker = createUnixViewerWorker({ socketPath, workerKey, generation });
  const response = await worker.handle(
    new Request("http://viewer.test/runs/demo/events"),
    undefined,
    "/api/events",
    { runId: "demo", workerKey, generation },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toBe("event: one\n\nevent: two\n\n");
});

test("Unix worker transport rejects stale generations before connecting", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "viewer-socket-")));
  roots.push(root);
  const workerKey = "schema-2/contract-2@release-a";
  const generation = createWorkerGeneration();
  const socketPath = viewerWorkerSocketPath(root, workerKey, generation);
  const server = await startUnixViewerWorkerServer({
    socketPath,
    workerKey,
    generation,
    handle: () => new Response("ok"),
  });
  servers.push(server);
  const worker = createUnixViewerWorker({
    socketPath,
    workerKey,
    generation,
  });
  await expect(
    worker.handle(
      new Request("http://viewer.test/runs/demo/"),
      undefined,
      "/",
      { runId: "demo", workerKey, generation: createWorkerGeneration() },
    ),
  ).rejects.toThrow("generation mismatch");
});

test("stopping a Unix worker removes only its own socket", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "viewer-socket-")));
  roots.push(root);
  const workerKey = "schema-2/contract-2@release-a";
  const generation = createWorkerGeneration();
  const socketPath = viewerWorkerSocketPath(root, workerKey, generation);
  const server = await startUnixViewerWorkerServer({
    socketPath,
    workerKey,
    generation,
    handle: () => new Response("ok"),
  });
  await server.stop();
  expect(() => lstatSync(socketPath)).toThrow();
});
