import { expect, test } from "bun:test";
import { mockCli } from "./role-flow-cli";
import { modernFixture } from "./role-flow-fixtures";

test("public CLI owns native creation, fences actors/revisions and never recreates unknown identity", async () => {
  const cli = mockCli(modernFixture());
  try {
    expect(
      (await cli.run("dispatch-claim", { task_id: "task-a", operation_id: "dispatch" })).code,
    ).toBe("APPLIED");
    for (const command of ["dispatch-bind-request", "dispatch-resolve"]) {
      expect((await cli.run(command, { operation_id: "dispatch" })).code).toBe("CLI_ONLY_DISPATCH");
    }
    const create = { operation_id: "dispatch", title: "Task A", prompt: "Formal task handoff" };
    expect(
      (
        await cli.run("conversation-create", create, {
          actor: { role: "main", thread_id: "foreign" },
        })
      ).exit,
    ).not.toBe(0);
    expect((await cli.run("conversation-create", create, { revision: 0 })).code).toBe(
      "REVISION_CONFLICT",
    );
    expect(cli.calls()).toEqual([]);
    expect(
      (await cli.run("conversation-create", create, { requestId: "create", unknown: true })).exit,
    ).toBe(0);
    const unknown = cli.store.read();
    expect(unknown.operations.find((o) => o.id === "dispatch")?.status).toBe("unknown");
    expect(unknown.tasks[0]?.thread_id).toBeNull();
    expect((await cli.run("conversation-create", create, { requestId: "create" })).code).toBe(
      "REPLAYED",
    );
    expect((await cli.run("conversation-create", create)).code).toBe("CREATION_PENDING");
    expect((await cli.run("creation-reconcile", { operation_id: "dispatch" })).exit).toBe(0);
    const resolved = cli.store.read();
    expect(resolved.tasks[0]?.thread_id).toStartWith("mock-");
    expect(resolved.operations.find((o) => o.id === "dispatch")?.status).toBe("succeeded");
    expect(cli.calls()).toEqual(["create", "reconcile"]);
    expect(
      resolved.notifications.some((n) => n.recipient_thread_id === resolved.tasks[0]?.thread_id),
    ).toBe(true);
  } finally {
    cli.cleanup();
  }
});

test("public conversation-create binds a completed mock initialization and replays without another Codex call", async () => {
  const cli = mockCli(modernFixture());
  try {
    expect(
      (await cli.run("dispatch-claim", { task_id: "task-a", operation_id: "dispatch" })).exit,
    ).toBe(0);
    const payload = { operation_id: "dispatch", title: "Task A", prompt: "Formal handoff" };
    expect((await cli.run("conversation-create", payload, { requestId: "create" })).exit).toBe(0);
    expect(cli.store.read().tasks[0]?.thread_id).toStartWith("mock-");
    expect((await cli.run("conversation-create", payload, { requestId: "create" })).code).toBe(
      "REPLAYED",
    );
    expect(cli.calls()).toEqual(["create"]);
  } finally {
    cli.cleanup();
  }
});
