import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  eventText,
  finding,
  readJsonLines,
  result,
  type Finding,
  type ReplayResult,
} from "./replay";

const missingEgo =
  /(?:没有看到|没看到|未看到|没有可调用|没有可用|不可调用|不可用|失败|only exposed|not exposed|not directly visible|unavailable|failed)[\s\S]{0,160}(?:ego-browser|Ego Browser)|(?:ego-browser|Ego Browser)[\s\S]{0,160}(?:没有看到|没看到|未看到|没有可调用|没有可用|不可调用|不可用|失败|not exposed|not directly visible|unavailable|failed)/i;
const chromeFallback =
  /(?:是否|允许|准许|approve|permission|可以|我可以|这次)[\s\S]{0,160}(?:chrome:control-chrome|Chrome Control|control Chrome)[\s\S]{0,120}(?:打开|open|navigate|browser|浏览器|页面|page)|(?:chrome:control-chrome|Chrome Control|control Chrome)[\s\S]{0,160}(?:是否|允许|准许|approve|permission|可以|这次)[\s\S]{0,120}(?:打开|open|navigate|browser|浏览器|页面|page)/i;

export function analyzeBrowserReplay(path: string): ReplayResult {
  const findings: Finding[] = [];
  let missingLine: number | undefined;
  for (const { line, value } of readJsonLines(path)) {
    const text = eventText(value);
    if (!text) continue;
    if (missingEgo.test(text)) missingLine = line;
    if (missingLine !== undefined && chromeFallback.test(text))
      findings.push(
        finding(
          "BAD_CHROME_FALLBACK",
          line,
          "Chrome control was offered after ego-browser was reported unavailable or failed.",
        ),
      );
  }
  return result(findings);
}

export interface BrowserPolicyOptions {
  repoRoot: string;
  sources?: string[];
}

export function analyzeBrowserPolicy(options: BrowserPolicyOptions): Finding[] {
  const root = options.repoRoot;
  const sources = options.sources ?? [
    "AGENTS.md",
    "skills/gui-escalation-gate/SKILL.md",
    "docs/specs/gui-escalation-gate/SPEC.md",
  ];
  const findings: Finding[] = [];
  const agents = readFileSync(`${root}/AGENTS.md`, "utf8");
  if (!agents.includes("浏览器任务默认使用 `$ego-browser`"))
    findings.push(
      finding(
        "AGENTS_MISSING_EGO_BROWSER_DEFAULT",
        1,
        "AGENTS.md must name $ego-browser as the default browser route.",
      ),
    );
  const chromeCount = agents.split("chrome:control-chrome").length - 1;
  if (chromeCount > 1)
    findings.push(
      finding(
        "AGENTS_CHROME_TOO_MANY",
        1,
        `AGENTS.md contains ${chromeCount} literal chrome:control-chrome references; expected <= 1 exception reference.`,
      ),
    );
  if (agents.includes("isolatedContext"))
    findings.push(
      finding(
        "AGENTS_DEVTOOLS_DETAIL",
        1,
        "AGENTS.md still contains detailed isolatedContext policy; keep that in the GUI gate skill/spec.",
      ),
    );
  const combined = sources
    .slice(1)
    .map((path) => readFileSync(`${root}/${path}`, "utf8"))
    .join("\n");
  for (const term of [
    "$ego-browser",
    "Ego Browser Standard",
    "Chrome Control Exception Gate",
  ])
    if (!combined.includes(term))
      findings.push(
        finding(
          "MISSING_EGO_BROWSER_CONTRACT",
          1,
          `Missing required ego-browser routing term: ${term}`,
        ),
      );
  const defaultChrome =
    /(?:默认(?:浏览器(?:入口|路径|路线)?)?(?:使用|是)?\s*`?(?:chrome:control-chrome|Chrome Control)|default(?: browser (?:path|route|entrypoint)?)?\s*(?:is|use)?\s*`?(?:chrome:control-chrome|Chrome Control))/i;
  for (const path of sources) {
    const text = readFileSync(`${root}/${path}`, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      if (defaultChrome.test(line))
        findings.push(
          finding(
            "ACTIVE_POLICY_DEFAULT_CHROME",
            index + 1,
            `${relative(root, `${root}/${path}`)} still makes Chrome control a default browser route.`,
          ),
        );
    });
  }
  return findings;
}
