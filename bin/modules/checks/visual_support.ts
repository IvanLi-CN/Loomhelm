export const lockPattern =
  /(?:必须|只能|要求|改用|改成|来自|从)\s*(?:web\s*demo|ui_demo)|(?:web\s*demo|ui_demo)\s*(?:获取|来源|作为最终证据|作为最终视觉证据)|(?:不得|不能)\s*(?:从|用)?\s*storybook|must\s+not\s+use\s+storybook|not\s+from\s+storybook|owner.{0,40}(?:require(?:s|d)?|insist(?:s|ed)?|lock(?:s|ed)?).{0,80}(?:web\s*demo|ui_demo)/i;
export const fullPage =
  /web_page|page-flow|app-shell|完整页面|整页|流程|page\s+evidence/i;
export const component =
  /component|fragment|组件|片段|reusable state|可复用状态/i;
export const componentOnly = /\bonly\b|\bjust\b|仅|只|仅仅/i;
export const pageScope =
  /(?:完整页面|页面|整页|(?:full\s+)?page(?:[-\s](?:flow|evidence|request|screen))?|app-shell)/i;
export const noUi =
  /no\s+(?:qualified|stable)?\s*ui_demo|(?:qualified|stable)\s+ui_demo\s+(?:is\s+)?unavailable|缺少(?:合格|稳定)?\s*ui_demo|没有(?:合格|稳定)?\s*ui_demo|不存在(?:合格|稳定)?\s*ui_demo|无(?:合格|稳定)?\s*ui_demo|(?:合格|稳定)?\s*ui_demo\s*(?:不可用|不可获得|无法使用)/i;
export const noUiNegation =
  /(?:并非|并不是|不是|并不|非|not|isn't|is\s+not).{0,20}(?:no\s+(?:qualified|stable)?\s*ui_demo|缺少(?:合格|稳定)?\s*ui_demo|没有(?:合格|稳定)?\s*ui_demo|不存在(?:合格|稳定)?\s*ui_demo|无(?:合格|稳定)?\s*ui_demo)/i;
export const noUiConditional =
  /(?:\bif\b|\bonly\s+if\b|\bunless\b|\bprovided\s+that\b|\bwhen\b|如果|若|仅当|除非|前提是|条件是).{0,100}(?:no\s+(?:qualified|stable)?\s*ui_demo|缺少(?:合格|稳定)?\s*ui_demo|没有(?:合格|稳定)?\s*ui_demo|不存在(?:合格|稳定)?\s*ui_demo|无(?:合格|稳定)?\s*ui_demo)/i;
export const storybook =
  /storybook|视觉证据目标源\s*[:=]\s*storybook_(?:docs|canvas)/i;
export const storyTarget = /视觉证据目标源\s*[:=]\s*storybook_(?:docs|canvas)/i;
export const uiTarget = /视觉证据目标源\s*[:=]\s*ui_demo/i;
export const storySuccess =
  /视觉证据\s*[:=]\s*存在|已满足原要求|story.*success|storybook.*成功态/i;
export const storyRoute =
  /\$storybook-(?:stories|screenshots)|storybook_docs|storybook_canvas|走\s*storybook|用\s*storybook|story.*fallback|Storybook/i;
export const permission =
  /可以|可|允许|准许|同意|批准|授权|许可|获准|allow(?:ed|s)?|approve(?:d|s)?|authori[sz](?:e|ed|es|ation)|permitted|can\s+use/gi;
export const permissionNegation =
  /不得|禁止|不能|不可|不允许|不使用|不用|不走|不要|尚未|未获|未得到|未|不|must\s+not|\bnot\s+allowed\b|do\s+not\s+use|\bnever\b|\bwithout\b|\bavoid\b|\bnot\s+yet\b|\bnot\b|\bno\s+longer\b|\bdisallowed\b|\bdisapproved\b|\bunapproved\b/i;
export const conditional =
  /conditional|only\s+if|only\s+after|\bafter\b|\bif\b|\bunless\b|provided\s+that|subject\s+to|pending|如果|若|仅当|除非|前提是|前提为|条件是|待/i;
export const question = /吗|么|呢|[?？]/;
export const multiPage =
  /\b(?:both|all|multiple|each|every)\s+(?:requested\s+)?pages?\b|\brequested\s+pages?\b|(?:两个|多个|所有|各个|这些)(?:完整)?页面/i;
export const revoke =
  /(?:withdraw|revoke|remove|lift|release|drop|override|no\s+longer\s+require|no\s+longer\s+lock|改口|撤销|解除|取消|不再要求|不再锁定)[^。！？?!;；\n.]{0,100}(?:source\s+lock|(?:that|the|previous|earlier)\s+(?:source\s+)?(?:requirement|lock)|ui_demo|web\s*demo|来源(?:锁定|要求)?|(?:该|原|之前|主人)(?:来源)?(?:要求|锁定))|(?:source\s+lock|(?:that|the|previous|earlier)\s+(?:source\s+)?(?:requirement|lock)|ui_demo|web\s*demo|来源(?:锁定|要求)?|(?:该|原|之前|主人)(?:来源)?(?:要求|锁定))[^。！？?!;；\n.]{0,100}(?:withdraw|revoke|remove|lift|release|drop|override|no\s+longer\s+require|no\s+longer\s+lock|改口|撤销|解除|取消|不再要求|不再锁定)/i;
export const visualPending =
  /视觉比较\s*[:=]\s*(?:需确认|有差异|不可比较|无基线)|(?:截图|图片).{0,36}(?:准确反映|是否准确).{0,24}(?:确认|吗)|visual(?:\s+comparison)?\s*(?:needs confirmation|pending)|does this (?:screenshot|image).{0,40}(?:accurately|reflect)/i;
export const visualAccept =
  /(?<!不)(?:确认|同意|批准).{0,36}(?:截图|图片|视觉|证据)|(?:这些|当前|该)?\s*(?:截图|图片|视觉|证据)(?:(?!不).){0,36}(?:准确|正确|没问题|符合|(?:可以|能够)反映|可以确认)|^\s*(?:(?:可以|没问题|准确|正确|是的|对(?:的)?|好的|确认|同意)\s*[，,、]?\s*)+(?:继续)?[。！!]?\s*$/i;
export const visualReject =
  /不(?:确认|同意|批准)|(?:截图|图片|视觉|证据).{0,36}(?:不准确|不正确|不可以|不符合|不能反映|不行|有误)/i;
export const candidateChanged =
  /(?:候选|渲染面|render(?:ed)?\s*(?:surface|input)s?).{0,24}(?:变化|变更|更新|changed)|候选(?:渲染|截图|图片).{0,24}(?:变化|变更|更新)/i;
export const prRoute =
  /skills\/project-engineering-workflow\/references\/pr-publication-procedure\.md|(?:shared workflow|workflow) PR publication procedure|\$pr-create|bind-pr|(?:创建|进入|开始|启动|继续).{0,30}(?:PR.*(?:收敛|convergence)|正式\s*review|CI\s*tracking|合并)/i;
const pageName =
  /\b(?:(?:the|this|that|current|another|different|new)\s+)?([a-z][a-z0-9_-]*)\s+(?:full[-\s])?page\b/gi;
const excludedNames = new Set(
  "the this that current another different new full page complete whole for use to is are was were approved approve allow allowed can could should owner requires required must needs need come from evidence project documentation docs not no qualified ui_demo storybook fallback".split(
    " ",
  ),
);

export interface LockState {
  line: number;
  blocked: boolean;
}
export interface PageState {
  full: boolean;
  noUi: boolean;
  conditionalNoUi: boolean;
  fallback: boolean;
  checked: boolean;
  lock?: LockState;
}
export interface VisualState {
  line: number;
  request: boolean;
}

function normalizePage(raw: string): string | undefined {
  const name = raw.toLowerCase().replace(/-/g, " ").trim();
  return !name || excludedNames.has(name) ? undefined : `page:${name}`;
}

export function namedPages(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(pageName)) {
    const key = normalizePage(match[1] ?? "");
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function localPages(text: string, position: number): string[] {
  const left = [
    ...text.slice(0, position).matchAll(/[。！？?!;；\n.,，、]/g),
  ].at(-1);
  const start = left ? (left.index ?? 0) + left[0].length : 0;
  const right = /[。！？?!;；\n.,，、]/.exec(text.slice(position));
  const end = right ? position + (right.index ?? 0) : text.length;
  return namedPages(text.slice(start, end));
}

export function pageAt(
  text: string,
  position: number,
  fallback: string,
): string {
  const local = localPages(text, position);
  if (local.length === 1) return local[0]!;
  const matches = [...text.matchAll(pageName)].filter(
    (match) => (match.index ?? 0) < position,
  );
  return normalizePage(matches.at(-1)?.[1] ?? "") ?? fallback;
}

export function factPages(
  text: string,
  pattern: RegExp,
  fallback: string[],
): string[] {
  const keys: string[] = [];
  const source = new RegExp(
    pattern.source,
    `${pattern.flags.replace("g", "")}g`,
  );
  for (const match of text.matchAll(source)) {
    const local = localPages(text, match.index ?? 0);
    for (const key of local.length ? local : fallback)
      if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function sourceLockPages(text: string, fallback: string[]): string[] {
  return factPages(text, /web\s*demo|ui_demo/gi, fallback);
}

export function authorization(
  text: string,
  fallback: string,
): Map<string, boolean> {
  const latest = new Map<string, { position: number; allowed: boolean }>();
  let offset = 0;
  for (const clause of text.split(/(?<=[。！？?!;；\n.])/)) {
    if (!storybook.test(clause) || !pageScope.test(clause)) {
      offset += clause.length;
      continue;
    }
    const target = namedPages(clause).at(-1) ?? fallback;
    const terms = [...clause.matchAll(new RegExp(permission.source, "gi"))];
    const spans = terms.length
      ? terms
      : [{ index: 0, 0: "" } as RegExpMatchArray];
    let previousEnd = 0;
    for (const term of spans) {
      const position = term.index ?? 0;
      const preceding = clause.slice(previousEnd, position);
      const allowed =
        Boolean(terms.length) &&
        !question.test(clause) &&
        !permissionNegation.test(preceding + term[0]) &&
        !permissionNegation.test(clause.slice(position + term[0].length)) &&
        !conditional.test(preceding) &&
        !conditional.test(clause.slice(position + term[0].length));
      const key = terms.length ? pageAt(clause, position, target) : target;
      latest.set(key, { position: offset + position, allowed });
      previousEnd = position + term[0].length;
    }
    if (
      /(?:release|发布)/i.test(clause) &&
      /(?:not|不|不得|不能).{0,60}(?:storybook|fallback)/i.test(clause)
    )
      latest.set(target, { position: offset + clause.length, allowed: false });
    const tail = text.slice(
      offset + clause.length,
      offset + clause.length + 160,
    );
    if (
      conditional.test(tail) &&
      /(?:owner|approval|授权|批准|允许)/i.test(tail)
    )
      latest.set(target, {
        position: offset + clause.length + tail.length,
        allowed: false,
      });
    if (
      /(?:storybook|fallback).{0,100}(?:not\s+for\s+(?:this|the)\s+(?:full\s+)?page|(?:该|此|这个)(?:完整)?页面(?:不得|不能|不允许|未获|未被))/i.test(
        clause,
      )
    )
      latest.set(target, { position: offset + clause.length, allowed: false });
    offset += clause.length;
  }
  return new Map([...latest].map(([key, state]) => [key, state.allowed]));
}

export function stateFor(
  states: Map<string, PageState>,
  key: string,
): PageState {
  const current = states.get(key);
  if (current) return current;
  const created: PageState = {
    full: false,
    noUi: false,
    conditionalNoUi: false,
    fallback: false,
    checked: false,
  };
  states.set(key, created);
  return created;
}
