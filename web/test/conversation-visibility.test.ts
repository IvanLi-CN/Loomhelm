import { describe, expect, test } from "bun:test";

import { codexQueryKeys, codexRouteKey, parseCodexRouteKey } from "../src/features/codex/source";

describe("conversation visibility routing", () => {
  test("keeps an imported Codex detail route source-scoped", () => {
    const routeKey = codexRouteKey("host/default", "thread:one");

    expect(routeKey).toBe("codex:host%2Fdefault:thread%3Aone");
    expect(parseCodexRouteKey(routeKey)).toEqual({ hostId: "host/default", threadId: "thread:one" });
    expect(parseCodexRouteKey("session-demo-u03")).toBeUndefined();
  });

  test("isolates Codex overview cache by principal and session generation", () => {
    const current = codexQueryKeys.overview("user/current", 4, "", false);

    expect(codexQueryKeys.overview("user/other", 4, "", false)).not.toEqual(current);
    expect(codexQueryKeys.overview("user/current", 5, "", false)).not.toEqual(current);
    expect(codexQueryKeys.overview("user/current", 4, "search", false)).not.toEqual(current);
  });
});
