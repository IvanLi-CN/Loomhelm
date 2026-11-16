import { describe, expect, test } from "bun:test";
import { type CommandDomain, indexCommandDomains } from "../lib/engine-command-context";

describe("engine command domains", () => {
  test("rejects overlapping command ownership", () => {
    const handler = () => ({ ok: true });
    const domains: CommandDomain[] = [
      { commands: ["plan-propose"], handle: handler },
      { commands: ["plan-propose"], handle: handler },
    ];

    expect(() => indexCommandDomains(domains)).toThrow(
      "Command assigned to multiple domains: plan-propose",
    );
  });

  test("indexes every declared command to its domain handler", () => {
    const coordination = () => ({ domain: "coordination" });
    const publication = () => ({ domain: "publication" });
    const handlers = indexCommandDomains([
      { commands: ["plan-propose", "plan-approve"], handle: coordination },
      { commands: ["publish-pr-claim"], handle: publication },
    ]);

    expect(handlers.get("plan-propose")?.({} as never)).toEqual({ domain: "coordination" });
    expect(handlers.get("publish-pr-claim")?.({} as never)).toEqual({ domain: "publication" });
    expect(handlers.has("merge-claim")).toBe(false);
  });
});
