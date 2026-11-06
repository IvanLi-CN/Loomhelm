import { describe, expect, test } from "bun:test";

import { createPublishedSessionApi } from "./api";

describe("published session API", () => {
  test("forwards artifact download request options to the generated client", async () => {
    const controller = new AbortController();
    const calls = [];
    const api = createPublishedSessionApi({
      downloadArtifact: async (request, requestInit) => {
        calls.push({ request, requestInit });
        return new Response(new Uint8Array([1]), { status: 200 });
      },
    });

    await api.downloadArtifact({ artifact_id: "artifact-session-api" }, { signal: controller.signal });

    expect(calls).toEqual([{ request: { artifact_id: "artifact-session-api" }, requestInit: { signal: controller.signal } }]);
  });
});
