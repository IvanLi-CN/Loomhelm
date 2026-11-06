import { describe, expect, test } from "bun:test";

import { getRunUiPhase } from "./RunStatusCard";

const base = {
  connection: "online",
  runStatus: "running",
  sessionState: "active"
};

describe("run status card phase precedence", () => {
  test("keeps an interrupted run terminal while a stale interrupt flag remains", () => {
    expect(getRunUiPhase({ ...base, interruptRequested: true, runStatus: "interrupted" })).toBe("terminated");
  });

  test("keeps completed and failed runs terminal over a stale interrupt flag", () => {
    expect(getRunUiPhase({ ...base, interruptRequested: true, runStatus: "completed" })).toBe("completed");
    expect(getRunUiPhase({ ...base, interruptRequested: true, runStatus: "failed" })).toBe("failed");
  });
});
