import {
  eventTexts,
  finding,
  readJsonLines,
  result,
  type Finding,
  type ReplayResult,
} from "./replay";
import {
  authorization,
  candidateChanged,
  component,
  componentOnly,
  factPages,
  fullPage,
  lockPattern,
  multiPage,
  namedPages,
  noUi,
  noUiConditional,
  noUiNegation,
  pageScope,
  prRoute,
  revoke,
  sourceLockPages,
  stateFor,
  storyRoute,
  storySuccess,
  storyTarget,
  type PageState,
  type VisualState,
  uiTarget,
  visualAccept,
  visualPending,
  visualReject,
} from "./visual_support";

export function analyzeVisualReplay(path: string): ReplayResult {
  const findings: Finding[] = [];
  const states = new Map<string, PageState>();
  let active: string | undefined;
  let anonymous = 1;
  let componentContext = false;
  let response: VisualState | undefined;
  const targets = (text: string, allocate: boolean): string[] => {
    const named = namedPages(text);
    if (named.length) return named;
    if (
      allocate &&
      /\b(?:another|different|new|other)\s+(?:full[-\s])?page\b|(?:另一个|其他|新的)(?:完整)?页面/i.test(
        text,
      )
    )
      return [`page:anonymous:${anonymous++}`];
    return [active ?? "page:generic"];
  };
  for (const { line, value } of readJsonLines(path)) {
    const { role, texts } = eventTexts(value);
    const joined = texts.join("\n");
    if (!joined) continue;
    const names = namedPages(joined);
    const componentOnlyTurn =
      role === "user" &&
      component.test(joined) &&
      componentOnly.test(joined) &&
      !fullPage.test(joined) &&
      !/storybook|fallback/i.test(joined) &&
      !lockPattern.test(joined) &&
      !noUi.test(joined);
    const userPage =
      role === "user" && pageScope.test(joined) && !componentOnlyTurn;
    const assistantPage =
      role === "assistant" &&
      /storybook|fallback/i.test(joined) &&
      pageScope.test(joined) &&
      !(component.test(joined) && componentOnly.test(joined));
    const fullTurn = fullPage.test(joined) || userPage || assistantPage;
    let pageTargets: string[] = [];
    if (fullTurn) {
      pageTargets = targets(joined, role === "user");
      if (role === "user") {
        active = pageTargets.length === 1 ? pageTargets[0] : undefined;
        for (const key of pageTargets) {
          const state = stateFor(states, key);
          state.full = false;
          state.noUi = false;
          state.conditionalNoUi = false;
          state.fallback = false;
          state.checked = false;
        }
      }
      for (const key of pageTargets) stateFor(states, key).full = true;
      componentContext = false;
    } else if (componentOnlyTurn)
      pageTargets = names.length ? names : [active ?? "page:generic"];
    else if (
      role === "user" &&
      (lockPattern.test(joined) || /storybook|fallback/i.test(joined))
    )
      pageTargets = targets(joined, false);
    else if (role === "assistant" && storyRoute.test(joined))
      pageTargets = targets(joined, false);
    if (component.test(joined) && !fullPage.test(joined) && !fullTurn)
      componentContext = true;
    const affected = pageTargets.length
      ? pageTargets
      : active
        ? [active]
        : ["page:generic"];
    const noTargets = factPages(joined, noUi, affected);
    const negativeTargets = factPages(joined, noUiNegation, affected);
    const conditionalTargets = factPages(joined, noUiConditional, affected);
    const availableTargets = factPages(
      joined,
      /(?<!no\s)(?<!not\s)(?<!没有)(?<!缺少)(?<!不存在)(?<!无)(?:qualified|stable)\s+ui_demo\s+(?:exists|is\s+available)|(?:有|存在|提供|可用).{0,12}(?:合格|稳定)\s*ui_demo/gi,
      affected,
    );
    const targetKeys = [
      ...new Set([
        ...noTargets,
        ...negativeTargets,
        ...conditionalTargets,
        ...availableTargets,
        ...factPages(joined, uiTarget, affected),
      ]),
    ];
    for (const key of targetKeys) {
      const state = stateFor(states, key);
      if (conditionalTargets.includes(key)) {
        state.conditionalNoUi = true;
        state.noUi = false;
      } else if (negativeTargets.includes(key) && role === "user") {
        state.conditionalNoUi = false;
        state.noUi = false;
      } else if (
        noTargets.includes(key) &&
        !(role === "assistant" && state.conditionalNoUi)
      ) {
        state.conditionalNoUi = false;
        state.noUi = true;
      }
      if (availableTargets.includes(key) || uiTarget.test(joined)) {
        state.noUi = false;
        state.fallback = false;
      }
      if (
        /qualified\s+ui_demo|合格\s*ui_demo|stable\s+ui_demo|ui_demo/i.test(
          joined,
        )
      )
        state.checked = true;
    }
    const auth =
      role === "user"
        ? authorization(joined, affected[0]!)
        : new Map<string, boolean>();
    for (const [key, allowed] of auth) stateFor(states, key).fallback = allowed;
    if (role === "user" && lockPattern.test(joined)) {
      for (const key of sourceLockPages(joined, affected)) {
        const state = stateFor(states, key);
        state.lock = { line, blocked: false };
        state.full = true;
      }
    }
    if (role === "user" && revoke.test(joined))
      for (const key of factPages(
        joined,
        revoke,
        names.length ? names : affected,
      ))
        if (auth.get(key) === true) delete stateFor(states, key).lock;
    if (role === "assistant" && visualPending.test(joined))
      response = { line, request: true };
    else if (role === "assistant" && candidateChanged.test(joined))
      response = { line, request: false };
    else if (
      role === "assistant" &&
      /视觉比较\s*[:=]\s*(?:一致|无差异|unchanged|same)|与上一版视觉一致/i.test(
        joined,
      )
    )
      response = undefined;
    if (
      role === "user" &&
      response?.request &&
      visualAccept.test(joined) &&
      !visualReject.test(joined)
    )
      response = undefined;
    if (role === "assistant" && response && prRoute.test(joined))
      findings.push(
        finding(
          "UI_PR_CONVERGENCE_BEFORE_VISUAL_RESPONSE",
          line,
          `visual_response_line=${response.line}`,
        ),
      );
    const contextKeys = [...states]
      .filter(([, state]) => state.full)
      .map(([key]) => key);
    // Python's legacy checker only evaluates Storybook routes emitted as
    // assistant messages. Tool-call arguments can mention Storybook while
    // merely describing an invocation; treating them as routes creates
    // duplicate findings for the same replay case.
    if (role !== "assistant" || line <= 1 || !storyRoute.test(joined)) continue;
    const lockKeys = names.length
      ? names
      : active
        ? [active]
        : contextKeys.length
          ? contextKeys
          : ["page:generic"];
    let lockedFinding = false;
    if (
      role === "assistant" &&
      storyTarget.test(joined) &&
      storySuccess.test(joined) &&
      !componentContext
    )
      for (const key of lockKeys) {
        const state = states.get(key);
        if (state?.lock && line > state.lock.line) {
          if (
            /blocker|不可用|需要先修复|视觉证据\s*[:=]\s*不存在/i.test(joined)
          )
            state.lock.blocked = true;
          findings.push(
            finding(
              "LOCKED_NON_STORYBOOK_SOURCE_REPLACED_BY_STORYBOOK",
              line,
              `storybook_line=${line} owner_lock_line=${state.lock.line} page=${key}`,
            ),
          );
          lockedFinding = true;
          break;
        }
      }
    const routeNames = names;
    const ambiguous =
      contextKeys.length > 1 &&
      multiPage.test(joined) &&
      routeNames.length < contextKeys.length;
    const routeKey =
      routeNames.length === 1
        ? routeNames[0]
        : !routeNames.length && active
          ? active
          : !routeNames.length && contextKeys.length === 1
            ? contextKeys[0]
            : undefined;
    if (ambiguous && !lockedFinding && contextKeys.length) {
      findings.push(
        finding(
          contextKeys.every((key) => states.get(key)?.noUi)
            ? "FULL_PAGE_STORYBOOK_FALLBACK_WITHOUT_EXPLICIT_EXCEPTION"
            : "FULL_PAGE_STORYBOOK_BEFORE_UI_DEMO_CHECK",
          line,
          `storybook_line=${line} page=ambiguous`,
        ),
      );
      continue;
    }
    const state = routeKey ? states.get(routeKey) : undefined;
    if (state?.full && !componentContext && !lockedFinding && !state.lock) {
      if (!(state.noUi && state.fallback))
        findings.push(
          finding(
            state.noUi
              ? "FULL_PAGE_STORYBOOK_FALLBACK_WITHOUT_EXPLICIT_EXCEPTION"
              : "FULL_PAGE_STORYBOOK_BEFORE_UI_DEMO_CHECK",
            line,
            `storybook_line=${line} ui_demo_checked=${state.checked} no_ui_demo_confirmed=${state.noUi} explicit_page_fallback_authorized=${state.fallback} page=${routeKey}`,
          ),
        );
      state.full = false;
    }
  }
  return result(
    findings.filter(
      (item, index, all) =>
        all.findIndex(
          (other) => other.code === item.code && other.line === item.line,
        ) === index,
    ),
  );
}
