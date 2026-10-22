import { describe, expect, test } from "bun:test";
import {
  ApiClientConfigurationError,
  ApiClientError,
  LoomhelmApiClient,
  createAuthenticatedApiClient,
} from "../src/index";

describe("generated browser authentication transport", () => {
  test("reads the real session capability without issuing a token request", async () => {
    const calls = [];
    const session = { user_id: "user-1", csrf_protection: "same_origin" };
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method });
        return Response.json(session);
      },
    });

    expect(await client.getBrowserSession()).toEqual(session);
    expect(calls).toEqual([{ path: "/api/v1/auth/session", method: "GET" }]);
  });

  test("preserves an expired session response and accepts only completed logout", async () => {
    const error = { code: "unauthorized", message: "Session expired", request_id: "request-auth" };
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async (url) => url.pathname.endsWith("/session")
        ? Response.json(error, { status: 401 })
        : new Response(null, { status: 204 }),
    });

    try {
      await client.getBrowserSession();
      throw new Error("expired session was accepted");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiClientError);
      expect(caught.status).toBe(401);
      expect(caught.body).toEqual(error);
    }
    expect(await client.logoutBrowserSession()).toBeUndefined();
  });
});

describe("generated user credential transport", () => {
  test("creation preserves the explicit delegated scope and requires HTTP 201", async () => {
    const calls = [];
    const body = { name: "Task Agent", project_ids: ["project-1"] };
    const credential = {
      id: "credential-1",
      name: body.name,
      project_ids: body.project_ids,
      created_at: "2026-10-22T00:00:00Z",
      token: "synthetic-test-token",
    };
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body) });
        return Response.json({ credential }, { status: 201 });
      },
    });

    expect(await client.createUserCredential({ body })).toEqual({ credential });
    expect(calls).toEqual([{ path: "/api/v1/credentials", method: "POST", body }]);
    const unexpected = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async () => Response.json({ credential }),
    });
    await expect(unexpected.createUserCredential({ body })).rejects.toThrow("expected 201");
  });

  test("inventory and revocation preserve empty results, scoped denial and encoded identities", async () => {
    const calls = [];
    const denial = { code: "unauthorized", message: "Unrestricted user authority required", request_id: "credential-scope" };
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method });
        if (init.method === "GET") return Response.json({ items: [] });
        if (url.pathname.endsWith("/denied")) return Response.json(denial, { status: 403 });
        return new Response(null, { status: 204 });
      },
    });

    expect(await client.listUserCredentials()).toEqual({ items: [] });
    expect(await client.revokeUserCredential({ credential_id: "credential/A B?" })).toBeUndefined();
    try {
      await client.revokeUserCredential({ credential_id: "denied" });
      throw new Error("scoped denial was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      expect(error.status).toBe(403);
      expect(error.body).toEqual(denial);
    }
    expect(calls).toEqual([
      { path: "/api/v1/credentials", method: "GET" },
      { path: "/api/v1/credentials/credential%2FA%20B%3F", method: "DELETE" },
      { path: "/api/v1/credentials/denied", method: "DELETE" },
    ]);
  });
});

test("session creation sends the caller's stable intent identity", async () => {
  const calls = [];
  const client = new LoomhelmApiClient({
    baseUrl: "https://loomhelm.example",
    fetch: async (url, init) => {
      calls.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body) });
      return Response.json({ session: { id: "session-1" } });
    },
  });
  const body = { command_id: "create-intent-1", path: "new", prompt: "same work" };
  await client.createSession({ body });
  await client.createSession({ body });
  await client.createSession({ body: { ...body, command_id: "create-intent-2" } });
  expect(calls.map((call) => call.body.command_id)).toEqual(["create-intent-1", "create-intent-1", "create-intent-2"]);
  expect(calls.every((call) => call.path === "/api/v1/sessions" && call.method === "POST")).toBe(true);
});

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

describe("generated project membership transport", () => {
  test("grant encodes both identities and sends only the assignable role", async () => {
    const calls = [];
    const member = {
      project_id: "project/A B?",
      user_id: "user/A B?",
      role: "operator",
      created_at: "2026-10-21T00:00:00Z",
    };
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body) });
        return Response.json({ member });
      },
    });

    expect(await client.grantProjectMember({
      project_id: member.project_id,
      user_id: member.user_id,
      body: { role: "operator" },
    })).toEqual({ member });
    expect(calls).toEqual([{
      path: "/api/v1/projects/project%2FA%20B%3F/members/user%2FA%20B%3F",
      method: "PUT",
      body: { role: "operator" },
    }]);
  });

  test("list returns an explicit collection and revoke requires bodyless completion", async () => {
    const calls = [];
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method });
        return init.method === "GET"
          ? Response.json({ items: [] })
          : new Response(null, { status: 204 });
      },
    });

    expect(await client.listProjectMembers({ project_id: "project/1" })).toEqual({ items: [] });
    expect(await client.revokeProjectMember({ project_id: "project/1", user_id: "user/2" })).toBeUndefined();
    expect(calls).toEqual([
      { path: "/api/v1/projects/project%2F1/members", method: "GET" },
      { path: "/api/v1/projects/project%2F1/members/user%2F2", method: "DELETE" },
    ]);
  });

  test("membership denial preserves the API failure for the caller", async () => {
    const body = { code: "unauthorized", message: "Project creator required", request_id: "grant-denied" };
    const client = new LoomhelmApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async () => Response.json(body, { status: 403 }),
    });

    try {
      await client.grantProjectMember({ project_id: "project-1", user_id: "user-2", body: { role: "viewer" } });
      throw new Error("grant unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      expect(error.status).toBe(403);
      expect(error.body).toEqual(body);
    }
  });
});

describe("authenticated client transport", () => {
  test("requires a real same-origin browser bootstrap before cookie requests", async () => {
    const calls = [];
    const session = { user_id: "user-browser", csrf_protection: "same_origin" };
    let principalId;
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      browserProtection: "same_origin",
      onBrowserSession: (value) => {
        principalId = value.user_id;
      },
      fetch: async (url, init) => {
        calls.push({
          path: url.pathname,
          method: init.method,
          credentials: init.credentials,
          csrf: new Headers(init.headers).get("X-CSRF-Token")
        });
        return url.pathname.endsWith("/auth/session")
          ? Response.json(session)
          : Response.json({ project: { id: "project-1" } });
      }
    });

    await expect(client.listProjects()).rejects.toBeInstanceOf(ApiClientConfigurationError);
    expect(calls).toEqual([]);

    expect(await client.bootstrapBrowserSession()).toEqual(session);
    await client.createProject({ body: { name: "Project" } });

    expect(principalId).toBe(session.user_id);
    expect(calls).toEqual([
      { path: "/api/v1/auth/session", method: "GET", credentials: "include", csrf: null },
      { path: "/api/v1/projects", method: "POST", credentials: "include", csrf: null }
    ]);
  });

  test("rejects an invalid same-origin declaration and keeps mutations closed", async () => {
    const calls = [];
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      browserProtection: "same_origin",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method });
        return Response.json({ user_id: "user-browser", csrf_protection: "token" });
      }
    });

    await expect(client.bootstrapBrowserSession()).rejects.toBeInstanceOf(ApiClientConfigurationError);
    await expect(client.createProject({ body: { name: "Project" } })).rejects.toBeInstanceOf(ApiClientConfigurationError);
    expect(calls).toEqual([{ path: "/api/v1/auth/session", method: "GET" }]);
  });

  test("clears the browser bootstrap after a completed logout", async () => {
    const calls = [];
    const session = { user_id: "user-browser", csrf_protection: "same_origin" };
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      browserProtection: "same_origin",
      fetch: async (url, init) => {
        calls.push({ path: url.pathname, method: init.method });
        return url.pathname.endsWith("/auth/session")
          ? Response.json(session)
          : new Response(null, { status: 204 });
      }
    });

    await client.bootstrapBrowserSession();
    await client.logoutBrowserSession();
    await expect(client.listProjects()).rejects.toBeInstanceOf(ApiClientConfigurationError);
    expect(calls).toEqual([
      { path: "/api/v1/auth/session", method: "GET" },
      { path: "/api/v1/auth/logout", method: "POST" }
    ]);
  });

  test("rejects an in-flight bootstrap after session invalidation", async () => {
    let release;
    let requests = 0;
    const session = { user_id: "user-browser", csrf_protection: "same_origin" };
    const firstResponse = new Promise((resolve) => { release = resolve; });
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      browserProtection: "same_origin",
      fetch: async (url) => {
        requests += 1;
        return requests === 1 ? firstResponse : Response.json(session);
      }
    });

    const pending = client.bootstrapBrowserSession();
    client.invalidateBrowserSession();
    release(Response.json(session));

    await expect(pending).rejects.toBeInstanceOf(ApiClientConfigurationError);
    expect(await client.bootstrapBrowserSession()).toEqual(session);
    expect(requests).toBe(2);
  });

  test("does not let an invalidated bootstrap clear the replacement request", async () => {
    let releaseFirst;
    let releaseSecond;
    let requests = 0;
    const session = { user_id: "user-browser", csrf_protection: "same_origin" };
    const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
    const secondResponse = new Promise((resolve) => { releaseSecond = resolve; });
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      browserProtection: "same_origin",
      fetch: async () => {
        requests += 1;
        return requests === 1 ? firstResponse : secondResponse;
      }
    });

    const first = client.bootstrapBrowserSession();
    client.invalidateBrowserSession();
    const second = client.bootstrapBrowserSession();
    releaseFirst(Response.json(session));
    await expect(first).rejects.toBeInstanceOf(ApiClientConfigurationError);

    const third = client.bootstrapBrowserSession();
    releaseSecond(Response.json(session));
    expect(await second).toEqual(session);
    expect(await third).toEqual(session);
    expect(requests).toBe(2);
  });

  test("closes the same-origin gate after a 401 response", async () => {
    let requests = 0;
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      browserProtection: "same_origin",
      fetch: async (url) => {
        requests += 1;
        return url.pathname.endsWith("/auth/session")
          ? Response.json({ user_id: "user-browser", csrf_protection: "same_origin" })
          : Response.json({ code: "unauthorized" }, { status: 401 });
      }
    });

    await client.bootstrapBrowserSession();
    await expect(client.listProjects()).rejects.toBeInstanceOf(ApiClientError);
    await expect(client.listProjects()).rejects.toBeInstanceOf(ApiClientConfigurationError);
    expect(requests).toBe(2);
  });

  test("uses session credentials and injects a fresh CSRF token for mutations", async () => {
    const calls = [];
    let token = "csrf-1";
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      csrf: { getToken: () => token },
      fetch: async (url, init) => {
        calls.push({
          path: url.pathname,
          method: init.method,
          credentials: init.credentials,
          csrf: new Headers(init.headers).get("X-CSRF-Token")
        });
        return init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json(init.method === "GET" ? { items: [] } : { project: { id: "project-1" } });
      }
    });

    await client.listProjects();
    await client.createProject({ body: { name: "Project" } });
    token = "csrf-2";
    await client.deleteProject({ project_id: "project-1" });

    expect(calls).toEqual([
      { path: "/api/v1/projects", method: "GET", credentials: "include", csrf: null },
      { path: "/api/v1/projects", method: "POST", credentials: "include", csrf: "csrf-1" },
      { path: "/api/v1/projects/project-1", method: "DELETE", credentials: "include", csrf: "csrf-2" }
    ]);
  });

  test("fails closed before a mutation when CSRF assembly is missing", async () => {
    let requests = 0;
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      fetch: async () => {
        requests += 1;
        return Response.json({ ok: true });
      }
    });

    await expect(client.createProject({ body: { name: "Project" } })).rejects.toBeInstanceOf(ApiClientConfigurationError);
    expect(requests).toBe(0);
  });

  test("notifies the auth assembly on 401 without masking the API error", async () => {
    let unauthorizedStatus;
    const client = createAuthenticatedApiClient({
      baseUrl: "https://loomhelm.example",
      csrf: { getToken: () => "csrf-1" },
      onUnauthorized: (response) => {
        unauthorizedStatus = response.status;
      },
      fetch: async () => Response.json({ code: "unauthorized", message: "expired", request_id: "request-1" }, { status: 401 })
    });

    await expect(client.createProject({ body: { name: "Project" } })).rejects.toBeInstanceOf(ApiClientError);
    expect(unauthorizedStatus).toBe(401);
  });
});
