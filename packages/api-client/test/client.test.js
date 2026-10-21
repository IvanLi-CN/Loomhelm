import { describe, expect, test } from "bun:test";
import { ApiClientError, LoomhelmApiClient } from "../src/generated";

describe("generated project/task transport", () => {
  test("deletion accepts a bodyless 204 and encodes the resource identity", async () => {
    const calls = [];
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method, body: init.body });
        return new Response(null, { status: 204 });
      },
    });

    expect(await client.deleteProject({ project_id: "project/A B?" })).toBeUndefined();
    expect(calls).toEqual([
      { path: "/api/v1/projects/project%2FA%20B%3F", method: "DELETE", body: undefined },
    ]);
  });

  test("dependency writes preserve prerequisite-to-dependent direction", async () => {
    const calls = [];
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method });
        return new Response(null, { status: 204 });
      },
    });

    await client.addTaskDependency({ task_id: "dependent/1", prerequisite_task_id: "prerequisite/2" });
    await client.removeTaskDependency({ task_id: "dependent/1", prerequisite_task_id: "prerequisite/2" });
    expect(calls).toEqual([
      { path: "/api/v1/tasks/dependent%2F1/dependencies/prerequisite%2F2", method: "POST" },
      { path: "/api/v1/tasks/dependent%2F1/dependencies/prerequisite%2F2", method: "DELETE" },
    ]);
  });

  test("a protected deletion preserves the shared API error and its details", async () => {
    const body = {
      code: "conflict",
      message: "Task deletion is protected",
      request_id: "request-1",
      details: { reason: "preserved_execution" },
    };
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async () => Response.json(body, { status: 409 }),
    });

    let caught;
    try {
      await client.deleteTask({ task_id: "task-1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiClientError);
    expect(caught.status).toBe(409);
    expect(caught.body).toEqual(body);
  });

  test("an unexpected successful response does not satisfy a bodyless mutation", async () => {
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async () => Response.json({ pending: true }, { status: 202 }),
    });

    await expect(client.deleteTask({ task_id: "task-1" })).rejects.toThrow("expected 204");
  });

  test("relationship reads retain the two distinct relationship categories", async () => {
    const page = {
      parents: [{ kind: "parent_child", parent_task_id: "external-parent", child_task_id: "task-1", created_at: "2026-10-21T00:00:00Z" }],
      children: [],
      prerequisites: [{ kind: "prerequisite", prerequisite_task_id: "external-prerequisite", dependent_task_id: "task-1", created_at: "2026-10-21T00:00:00Z" }],
      dependents: [],
    };
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async () => Response.json(page),
    });

    expect(await client.getTaskRelationships({ task_id: "task-1" })).toEqual(page);
  });
});
