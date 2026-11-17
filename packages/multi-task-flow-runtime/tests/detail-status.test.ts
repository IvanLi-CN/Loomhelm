import { describe, expect, test } from "bun:test";
import {
  createDemoLedger,
  createPlanningDemoLedger,
} from "../examples/orchestration-viewer/ledger";
import { buildView } from "../lib/view";
import {
  deriveDetailStatus,
  GROUP_STATUS_STATES,
  TASK_STATUS_STATES,
} from "../web/detail-status-model";

const readiness = ["ready", "blocked", "unknown"] as const;
describe("detail status product", () => {
  test("keeps the producer's merged/runtime-ready/dispatch-blocked counterexample", () => {
    const group = buildView(createDemoLedger(1_767_200_000_000)).groups.find(
      (group) => group.id === "core",
    )!;
    expect([group.state, group.runtime_readiness.status, group.dispatch_readiness]).toEqual([
      "merged",
      "ready",
      "blocked",
    ]);
    expect(
      deriveDetailStatus({
        kind: "group",
        state: group.state,
        runtime: group.runtime_readiness.status,
        dispatch: group.dispatch_readiness,
      }).issue,
    ).toBeNull();
  });

  test("exhausts all 45 group tuples; retains 15 and rejects 30", () => {
    const keys = new Set<string>();
    for (const state of GROUP_STATUS_STATES)
      for (const runtime of readiness)
        for (const dispatch of readiness) {
          const result = deriveDetailStatus({ kind: "group", state, runtime, dispatch });
          const allowed =
            state === "active"
              ? dispatch !== "unknown"
              : state === "merged"
                ? dispatch === "blocked"
                : dispatch === "blocked" && runtime !== "ready";
          expect(result.issue === null).toBe(allowed);
          if (allowed) keys.add(result.key);
          else expect(result.icon).toBe("circle-help");
        }
    expect(keys.size).toBe(15);
  });
  test("does not invent coupling between task phase, owner runtime and dispatch policy", () => {
    const keys = new Set<string>();
    for (const state of TASK_STATUS_STATES)
      for (const runtime of readiness)
        for (const dispatch of readiness) {
          const result = deriveDetailStatus({ kind: "task", state, runtime, dispatch });
          expect(result.issue).toBeNull();
          keys.add(result.key);
        }
    expect(keys.size).toBe(90);
    expect(
      deriveDetailStatus({ kind: "task", state: "completed", runtime: "ready", dispatch: "ready" })
        .presentation,
    ).toBe("finished");
  });
  test("checks group constraints against raw state, not coordinator observation", () => {
    expect(
      deriveDetailStatus({
        kind: "group",
        state: "active",
        visualState: "blocked",
        runtime: "ready",
        dispatch: "ready",
      }),
    ).toMatchObject({ issue: null, presentation: "blocked" });
    expect(
      deriveDetailStatus({
        kind: "group",
        state: "closed",
        visualState: "running",
        runtime: "blocked",
        dispatch: "blocked",
      }).icon,
    ).toBe("circle-help");
  });
  test("unknown values, absent data and impossible tuples never look healthy", () => {
    const base = { kind: "group" as const, state: "active", runtime: "ready", dispatch: "ready" };
    for (const patch of [
      { state: "future-state" },
      { runtime: "future-state" },
      { dispatch: "future-state" },
      { visualState: "future-state" },
      { runtime: undefined },
      { dispatch: undefined },
      { state: "closed" },
      { state: "planned" },
    ])
      expect(deriveDetailStatus({ ...base, ...patch })).toMatchObject({
        icon: "circle-help",
        presentation: "unknown",
        tone: "muted",
      });
    expect(deriveDetailStatus({ ...base, runtime: "unknown" })).toMatchObject({
      icon: "circle-help",
      issue: null,
    });
  });
  test("keeps exact product identity when overview glyphs are shared", () => {
    const a = deriveDetailStatus({
      kind: "group",
      state: "active",
      runtime: "blocked",
      dispatch: "ready",
    });
    const b = deriveDetailStatus({
      kind: "group",
      state: "active",
      runtime: "blocked",
      dispatch: "blocked",
    });
    expect(a.icon).toBe(b.icon);
    expect(a.key).not.toBe(b.key);
  });
});
// Run the real producer; a domain change must explicitly update the UI relation.
describe("producer readiness invariants", () => {
  for (const state of GROUP_STATUS_STATES)
    for (const kind of ["regular", "bootstrap"] as const)
      for (const bound of [false, true])
        for (const ownership of ["uncertain", "bound"] as const) {
          if (kind === "bootstrap" && bound) continue;
          test(`${kind}/${state}/agent=${bound}/control=${ownership}`, () => {
            const ledger = createPlanningDemoLedger(1_767_200_000_000);
            ledger.contract_version = 2;
            ledger.source_schema_version = null;
            ledger.control.ownership = ownership;
            const owner = ledger.groups.find((group) => group.id === "core")!;
            owner.state = state;
            owner.delivery_unit_kind = kind;
            owner.owner_kind = kind === "bootstrap" ? "main" : "group";
            owner.agent_thread_id = bound ? "fixture-agent" : null;
            for (const group of buildView(ledger).groups) {
              if (group.state !== "active") expect(group.dispatch_readiness).toBe("blocked");
              if (["planned", "blocked", "closed"].includes(group.state))
                expect(group.runtime_readiness.status).not.toBe("ready");
              expect(["ready", "blocked"]).toContain(group.dispatch_readiness);
              expect(
                deriveDetailStatus({
                  kind: "group",
                  state: group.state,
                  runtime: group.runtime_readiness.status,
                  dispatch: group.dispatch_readiness,
                }).issue,
              ).toBeNull();
            }
          });
        }
});
