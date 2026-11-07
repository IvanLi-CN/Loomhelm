import { restoreViewStateForNavigation, type ViewState, type ViewStateValidation } from "./view-state";

export type PopStateTarget = {
  addEventListener: (type: "popstate", listener: () => void) => void;
  removeEventListener: (type: "popstate", listener: () => void) => void;
};

export type ViewStateNavigationHandlers = {
  getSearch: () => string;
  getValidation: (search?: string) => ViewStateValidation;
  getPhase: () => "planning" | "execution" | null;
  restore: (state: ViewState, hasExplicitTab: boolean) => void;
};

export function installViewStateNavigation(target: PopStateTarget, handlers: ViewStateNavigationHandlers): () => void {
  const onPopState = (): void => {
    const search = handlers.getSearch();
    const restored = restoreViewStateForNavigation(search, handlers.getValidation(search), handlers.getPhase());
    handlers.restore(restored.state, restored.hasExplicitTab);
  };
  target.addEventListener("popstate", onPopState);
  return () => target.removeEventListener("popstate", onPopState);
}
