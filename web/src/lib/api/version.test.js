import { describe, expect, test } from "bun:test";
import { versionedWebFetch } from "./version";
const build = { version: "1.2.3", source_sha: "a".repeat(40), policy: "loomhelm-manual-v1" };
describe("product Web connection guard", () => {
  test("rejects missing/malformed/different identity before a business request", async () => {
    for (const version of [undefined, "dev", "1.2", "1.2.4"]) {
      const calls = [];
      const guarded = versionedWebFetch(async (input) => { calls.push(String(input)); return Response.json({ version, policy: build.policy }); }, "https://example.test", build);
      await expect(guarded("https://example.test/api/v1/commands", { method: "POST" })).rejects.toThrow("版本");
      expect(calls).toEqual(["https://example.test/version"]);
    }
  });
  test("same version sends immutable header without mutating caller recovery context", async () => {
    const context = { draft: "unsubmitted input", session: "existing-session" };
    const calls = [];
    const guarded = versionedWebFetch(async (input, init) => { calls.push({ input: String(input), init }); return calls.length === 1 ? Response.json(build) : Response.json({ ok: true }); }, "https://example.test", build);
    await guarded("https://example.test/api/v1/commands", { method: "POST" });
    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[1].init.headers.get("X-Loomhelm-Version")).toBe("1.2.3");
    expect(context).toEqual({ draft: "unsubmitted input", session: "existing-session" });
  });
});
