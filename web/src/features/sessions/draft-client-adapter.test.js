import { describe, expect, test } from "bun:test";
import { ApiClientError } from "@loomhelm/api-client";

import { DraftClientAdapter } from "./draft-client-adapter";

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function draft(overrides = {}) {
  return {
    content: "shared draft",
    revision: 1,
    session_id: "session-1",
    updated_at: "2026-10-27T00:00:00Z",
    ...overrides,
  };
}

describe("draft client adapter", () => {
  test("reads the owner-scoped draft and sends ordered mutation metadata", async () => {
    const calls = [];
    const sequences = [];
    const adapter = new DraftClientAdapter({
      getDraft: async (request) => ({ draft: draft({ session_id: request.session_id, content: "from server", revision: 4, client_id: "client-1", client_sequence: 7 }) }),
      updateDraft: async (request) => {
        calls.push(request);
        return { draft: draft({ session_id: request.session_id, content: request.body.content, revision: 8, client_id: request.body.client_id, client_sequence: request.body.client_sequence }) };
      },
    }, { clientId: "client-1", writeSequence: (_sessionId, sequence) => sequences.push(sequence), createMutationId: () => "mutation-1" });

    adapter.selectSession("session-1");
    await expect(adapter.readDraft("session-1")).resolves.toMatchObject({ state: "received", draft: { content: "from server", revision: 4 } });
    await expect(adapter.updateDraft("session-1", "new text")).resolves.toMatchObject({ state: "received", draft: { content: "new text" } });
    expect(calls).toEqual([{
      session_id: "session-1",
      body: { client_id: "client-1", client_sequence: 8, content: "new text", mutation_id: "mutation-1" },
    }]);
    expect(sequences).toEqual([7, 8]);
  });

  test("does not publish a late read or update after switching sessions", async () => {
    const pendingRead = deferred();
    const pendingUpdate = deferred();
    let update = false;
    const adapter = new DraftClientAdapter({
      getDraft: () => pendingRead.promise,
      updateDraft: () => { update = true; return pendingUpdate.promise; },
    }, { clientId: "client-1" });

    adapter.selectSession("session-1");
    const read = adapter.readDraft("session-1");
    adapter.selectSession("session-2");
    pendingRead.resolve({ draft: draft() });
    await expect(read).resolves.toMatchObject({ state: "unknown", reason: "stale_response" });

    const write = adapter.updateDraft("session-2", "new");
    await Promise.resolve();
    expect(update).toBe(true);
    adapter.selectSession("session-1");
    pendingUpdate.resolve({ draft: draft({ content: "new" }) });
    await expect(write).resolves.toMatchObject({ state: "unknown", reason: "stale_response" });
  });

  test("coalesces an in-flight update and keeps permission failures explicit", async () => {
    const pending = deferred();
    const adapter = new DraftClientAdapter({
      getDraft: async () => ({ draft: draft() }),
      updateDraft: () => pending.promise,
    }, { clientId: "client-1" });

    adapter.selectSession("session-1");
    const first = adapter.updateDraft("session-1", "one");
    const duplicate = adapter.updateDraft("session-1", "two");
    pending.resolve({ draft: draft({ content: "one" }) });
    await expect(first).resolves.toMatchObject({ state: "received" });
    await expect(duplicate).resolves.toMatchObject({ state: "received" });

    const forbidden = new DraftClientAdapter({
      getDraft: async () => { throw new ApiClientError(403, { code: "forbidden" }); },
      updateDraft: async () => ({ draft: draft() }),
    }, { clientId: "client-1" });
    forbidden.selectSession("session-1");
    await expect(forbidden.readDraft("session-1")).resolves.toMatchObject({ state: "unknown", reason: "forbidden" });
  });

  test("rejects a foreign draft response", async () => {
    const adapter = new DraftClientAdapter({
      getDraft: async () => ({ draft: draft({ session_id: "session-2" }) }),
      updateDraft: async () => ({ draft: draft() }),
    }, { clientId: "client-1" });

    adapter.selectSession("session-1");
    await expect(adapter.readDraft("session-1")).resolves.toMatchObject({ state: "unknown", reason: "foreign_response" });
  });
});
