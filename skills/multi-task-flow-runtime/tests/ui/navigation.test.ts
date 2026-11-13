import { describe, expect, test } from "bun:test";
import { installViewStateNavigation } from "../../web/navigation";

describe("dashboard navigation event binding", () => {
  test("restores URL state on the actual popstate event path", () => {
    type Restored = { tab: string; selected: { kind: string; id: string } | null; hasExplicitTab: boolean };
    const target = window;
    let search = "?selected=task%3Atask-1&group=dashboard";
    let restored: Restored | null = null;
    const current = (): Restored | null => restored;
    const remove = installViewStateNavigation(target, {
      getSearch: () => search,
      getValidation: () => ({}),
      getPhase: () => "execution",
      restore: (state, hasExplicitTab) => { restored = { tab: state.tab, selected: state.selected, hasExplicitTab }; },
    });

    target.dispatchEvent(new Event("popstate"));
    expect(current()).toEqual({ tab: "actual", selected: { kind: "task", id: "task-1" }, hasExplicitTab: false });
    search = "?tab=graph&selected=task%3Atask-1";
    target.dispatchEvent(new Event("popstate"));
    expect(current()).toEqual({ tab: "graph", selected: { kind: "task", id: "task-1" }, hasExplicitTab: true });

    remove();
    restored = null;
    target.dispatchEvent(new Event("popstate"));
    expect(restored).toBeNull();
  });
});
