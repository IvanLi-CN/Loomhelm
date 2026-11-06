import {
  section,
  sectionHeadingCount,
  unfencedMarkerLines,
  validateFencedBlocks,
} from "./markdown";
import { parseAcceptance } from "./acceptance";
import { canonicalFacts, flowItems, flowType } from "./projection";

export interface ContractFinding {
  code: string;
  message: string;
}

const REQUIRED_SECTIONS = [
  "Summary",
  "Flow Decision",
  "Goals",
  "Non-goals",
  "Task Orchestration",
  "Acceptance & Validation",
  "Assumptions/Defaults",
] as const;

const ACTIVE_FLOW_TYPES = new Set([
  "fast-track",
  "normal",
  "local-merge",
  "implement-only",
]);
const RETIRED_FLOW_TYPES = new Set([
  "retired-initiative",
  "retired-parallel-pr",
  "wave-thread",
  "initiative",
  "parallel-pr",
]);

const PLACEHOLDER = /^(?:tba|todo|tbd|none|n\/a|待定|待补充|无)$/i;

function finding(code: string, message: string): ContractFinding {
  return { code, message };
}

function sectionHeadings(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*##\s+(.+?)\s*$/)?.[1])
    .filter((value): value is string => value !== undefined);
}

function field(text: string, name: string): string | undefined {
  const value = flowItems(section(text, "Flow Decision")).find(
    ([key]) => key === name,
  )?.[1];
  return value?.trim().replace(/^`|`$/g, "") || undefined;
}

function flowFieldValues(text: string, name: string): string[] {
  return flowItems(section(text, "Flow Decision"))
    .filter(([key]) => key === name)
    .map(([, value]) => value.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

function historicalFlowFieldValues(text: string, name: string): string[] {
  return flowItems(section(text, "Flow Decision"))
    .filter(([key]) => key === name)
    .map(([, value]) => value.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

function concreteBaseline(value: string | undefined): boolean {
  if (!value || /^(?:tba|tbd|none|n\/a|待定|待补充|无)$/i.test(value))
    return false;
  if (
    /^(?:the )?(?:current|default|main|trunk)\s+(?:branch|line)$/i.test(value)
  )
    return false;
  if (/\b(?:HEAD|head)\s*=\s*[0-9a-f]{7,64}\b/i.test(value)) return true;
  if (/^(?:origin|upstream)\/HEAD$/i.test(value)) return false;
  if (
    /^(?:\.\.?\/|\/|[A-Za-z]:[\\/])/.test(value) ||
    /\/(?:docs|src|test|tests)\//i.test(value)
  )
    return false;
  if (/^(?:origin|upstream)\/[A-Za-z0-9][A-Za-z0-9_.!+;\/-]*$/.test(value))
    return true;
  return (
    /(?:^|[/:])(?:main|master|trunk|develop|[A-Za-z0-9][A-Za-z0-9_.!+;\-]*)$/.test(
      value,
    ) || /^[0-9a-f]{7,64}$/i.test(value)
  );
}

function baselineReason(
  value: string | undefined,
): "abstract" | "invalid" | undefined {
  if (!value) return undefined;
  if (
    /^(?:the )?(?:current|default|main|trunk)\s+(?:branch|line)$/i.test(
      value,
    ) ||
    /^(?:mainline|default branch|current branch|主干|默认分支|当前分支|目标仓库主干|目标仓库主干基线)$/i.test(
      value,
    )
  )
    return "abstract";
  return concreteBaseline(value) ? undefined : "invalid";
}

function nonEmptySection(text: string, name: string): boolean {
  return section(text, name)
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      const value = trimmed.replace(/^-\s*/, "").trim();
      return (
        trimmed.startsWith("-") && value.length > 0 && !PLACEHOLDER.test(value)
      );
    });
}

const PERSISTED_PLAN_ARTIFACT =
  /(?:\b(?:write|create|add|update|maintain|keep|sync|persist|save|store|append|draft|author|record|generate|init(?:ialize)?|prepare|setup|set\s+up|read|open|load|view|inspect|move|copy|duplicate|clone|rename|relocate|archive)\b[^\n]{0,100}\b(?:PLAN\.md|PLANS\.md|progress\s+(?:ledger|log)|living\s+plan|plan\s+(?:ledger|log|artifact|decision\s+log)|persist(?:ed|ent)?\s+plan|decision\s+log|handoff\s+log)\b)|(?:\b(?:PLAN\.md|PLANS\.md|progress\s+(?:ledger|log)|living\s+plan|plan\s+(?:ledger|log|artifact|decision\s+log)|persist(?:ed|ent)?\s+plan|decision\s+log|handoff\s+log)\b[^\n]{0,100}\b(?:write|create|add|update|maintain|keep|sync|persist|save|store|append|draft|author|record|generate|init(?:ialize)?|prepare|setup|set\s+up|read|open|load|view|inspect|move|copy|duplicate|clone|rename|relocate|archive)\b)/i;

const FORMAL_REVIEW_PREDECLARATION =
  /(?:\$review-agent|formal[\s_-]+(?:code[\s_-]+)?review[\s_-]+(?:lane|wave|reviewer|agent|identity|profile)|formal[\s_-]+evidence|code[\s_-]+review[\s_-]+lane|正式\s*(?:代码)?审查|formal\s+lane|review[\s_-]*wave|reviewer(?:[\s_-]*(?:agent|identity|profile))?|required\s+lane|审查\s*(?:lane|批次|波次)|current[\s_-]*head.{0,40}(?:review|审查|formal[\s_-]*evidence)|(?:run|launch|start|schedule|create|execute|perform|运行|启动|创建|执行).{0,40}(?:formal[\s_-]+(?:code[\s_-]+)?review|tier[\s_-]*[34].{0,40}(?:formal|review|reviewer|lane|evidence|审查))|(?:^|:)\s*(?:reviewer|review-agent|policy-semantics|record-integrity|contract-language|regression-evidence|ui-accessibility|security|database-migration|release-infra)(?:\s|$))/i;

const LEGACY_PROFILE =
  /(?:^|[^A-Za-z0-9_])(model|model_reasoning_effort|reasoning_effort|effort)\s*=/i;

function writeIntentForbidden(text: string): boolean {
  if (
    /(?:must\s+not|should\s+not|not\s+allowed|forbidden|不得|禁止|不允许)[^;，。]{0,100}(?:then|and|并且|然后|;|，)[^;，。]{0,100}(?:write|modify|implement|push|create|update|写入|修改|实现|推送|创建|更新)/i.test(
      text,
    )
  )
    return true;
  if (
    /(?:只读|read[- ]only|must\s+not|should\s+not|not\s+(?:allowed|permitted|authorized|supposed)|forbidden|prohibited|不得|禁止|不应|不可|不能|不要|不允许|不准)/i.test(
      text,
    )
  )
    return false;
  if (
    /^(?:check|review|verify|inspect|analy[sz]e|检查|审阅|验证|分析|查看)\b/i.test(
      text,
    ) &&
    !/(?:write|modify|implement|push|create|delete|remove|move|copy|rename|update|edit|generate|save|store|overwrite|replace|append|apply|写入|修改|实现(?:功能|代码|文件|目录|路径|仓库|分支|源文件|文件系统|变更|修复)|推送|创建|删除|移除|移动|复制|重命名|更新|编辑|生成|保存|存储|覆盖|替换|追加|应用|git\s+(?:add|push|checkout|reset|clean|merge|rebase|stash|rm|mv|config|worktree)|tee\s+|>>?\s*\S+)/i.test(
      text,
    )
  )
    return false;
  const negated =
    /(?:must|should|shall|may|can|will|do|does|did)\s+(?:not|never)|never|no\s+(?:write|modify|implement|commit|push|create|update)|not\s+(?:allowed|permitted|authorized|supposed)\s+to|(?:forbidden|prohibited)\s+(?:to|from)|(?:不得|禁止|不应|不可|不能|不要|不允许|不准)/i;
  const clauses = text.split(
    /[;,，；。!！?？]|&&|\|\||\s+(?:or|and|but|then|或|或者|以及|并且|但是|但|然后)\s+/i,
  );
  if (/^\s*git\s+apply\s+--(?:check|stat|numstat|summary)\b/i.test(text))
    return false;
  if (
    /^\s*git\s+(?:config\s+(?:--get(?:-all|-regexp|-url|-color)?|--list|list)|worktree\s+list|stash\s+(?:list|show))\b/i.test(
      text,
    )
  )
    return false;
  return clauses.some(
    (clause) =>
      /(?:write|modify|implement|push|create|delete|remove|move|copy|rename|update|edit|generate|save|store|overwrite|replace|append|apply|实现(?:功能|代码|文件|目录|路径|仓库|分支|源文件|文件系统|变更|修复)|提交|推送|创建|删除|移除|移动|复制|重命名|更新|编辑|生成|保存|存储|覆盖|替换|追加|应用|共享工作区|当前工作树|shared workspace|worktree|git\s+(?:add|push|checkout|reset|clean|merge|rebase|stash|rm|mv|config|worktree)|(?:sed|perl|ruby)\s+.*(?:-i|--in-place)|tee\s+|>>?\s*\S+)/i.test(
        clause,
      ) && !negated.test(clause),
  );
}

function persistedArtifactForbidden(text: string): boolean {
  if (
    /(?:prepare|setup|create|generate|initialize|keep|maintain|update|move|copy|record|生成|准备|配置|创建|维护|更新|移动|复制|记录)[^\n]{0,100}(?:decision|handoff)\s+log/i.test(
      text,
    ) &&
    /(?:\b(?:future|next|planning|session|work)\b|后续|下一步|未来|计划|交接|会话|工作)/i.test(
      text,
    ) &&
    !/(?:ui|ux|page|view|viewer|screen|panel|table|list|api|endpoint|template|csv|export|import|entry|entries|product|customer|user)/i.test(
      text,
    )
  )
    return true;
  if (!PERSISTED_PLAN_ARTIFACT.test(text)) return false;
  const productSurface =
    /\b(?:ui|ux|page|view|viewer|screen|panel|table|list|filter|pagination|component|widget|api|endpoint|route|field|schema|model|templates?|csv|export|import|consumer|processor|parser|reader|handler|worker|integration|connector|storage|report|download|entries?|products?|customers?|users?)\b/i;
  const artifact =
    /(?:progress\s+(?:ledger|log)|decision\s+log|handoff\s+log|plan\s+(?:ledger|log|artifact|decision\s+log)|PLAN\.md|PLANS\.md)/i;
  return !(productSurface.test(text) && artifact.test(text));
}

function historicalField(text: string, name: string): string | undefined {
  return field(text, name);
}

function nonGoalPlaceholder(line: string): boolean {
  const value = line.trim().replace(/^-\s*/, "").trim();
  return /^(?:tba|todo|tbd|n\/a|none|no exclusions?|no non-goals?|无|无排除项|无非目标)$/i.test(
    value,
  );
}

function validateSectionShape(text: string, findings: ContractFinding[]): void {
  const headings = sectionHeadings(text);
  const positions = REQUIRED_SECTIONS.map((name) => headings.indexOf(name));
  for (const name of REQUIRED_SECTIONS) {
    if (sectionHeadingCount(text, name) === 0)
      findings.push(
        finding("MISSING_SECTION", `Missing required section: ## ${name}`),
      );
    if (sectionHeadingCount(text, name) > 1)
      findings.push(
        finding(
          "DUPLICATE_SECTION",
          `Section ## ${name} must appear exactly once`,
        ),
      );
  }
  if (positions.every((position) => position >= 0)) {
    for (let index = 1; index < positions.length; index += 1)
      if (positions[index]! <= positions[index - 1]!) {
        findings.push(
          finding(
            "INVALID_SECTION_ORDER",
            "Required plan sections are out of order",
          ),
        );
        break;
      }
  }
  for (const name of ["Summary", "Goals", "Non-goals"])
    if (sectionHeadingCount(text, name) === 1 && !nonEmptySection(text, name))
      findings.push(
        finding(
          `${name === "Summary" ? "EMPTY_SUMMARY" : name === "Goals" ? "EMPTY_GOALS" : "EMPTY_NON_GOALS"}`,
          `Section ## ${name} must contain a concrete bullet`,
        ),
      );
  if (
    sectionHeadingCount(text, "Assumptions/Defaults") === 1 &&
    !nonEmptySection(text, "Assumptions/Defaults")
  )
    findings.push(
      finding(
        "ASSUMPTIONS_EMPTY",
        "Section ## Assumptions/Defaults must contain a concrete bullet",
      ),
    );
}

function validateFlow(
  text: string,
  findings: ContractFinding[],
): string | undefined {
  const flowDecisionItems = flowItems(section(text, "Flow Decision"));
  const flowFieldCounts = new Map<string, number>();
  for (const [key] of flowDecisionItems)
    if (key) flowFieldCounts.set(key, (flowFieldCounts.get(key) ?? 0) + 1);
  for (const [name, count] of flowFieldCounts)
    if (count > 1)
      findings.push(
        finding(
          "DUPLICATE_FLOW_FIELD",
          `Flow Decision field ${name} must appear exactly once.`,
        ),
      );
  const raw = field(text, "flow_type");
  const type = flowType(text);
  if (!raw)
    findings.push(
      finding("MISSING_FLOW_TYPE", "Flow Decision must define flow_type."),
    );
  else if (
    !ACTIVE_FLOW_TYPES.has(type) ||
    raw.toLowerCase().replaceAll("_", "-").replace(/\s+/g, "-") !== type
  ) {
    const code =
      type === "multi-task-flow"
        ? "DEV_PLAN_MULTI_TASK_FLOW_FORBIDDEN"
        : RETIRED_FLOW_TYPES.has(type)
          ? "RETIRED_FLOW_TYPE"
          : "UNKNOWN_FLOW_TYPE";
    findings.push(
      finding(
        code,
        `flow_type=${raw} is not an active standalone dev-plan flow.`,
      ),
    );
  }
  const source = field(text, "flow_source");
  if (!source)
    findings.push(
      finding("MISSING_FLOW_SOURCE", "Flow Decision must define flow_source."),
    );
  const lock = field(text, "lock_status");
  if (!lock)
    findings.push(
      finding("MISSING_LOCK_STATUS", "Flow Decision must define lock_status."),
    );
  else if (lock !== "locked")
    findings.push(
      finding(
        "LOCK_STATUS_NOT_LOCKED",
        "Finalized raw plans require lock_status=locked.",
      ),
    );
  const baseline = field(text, "开发基线") ?? field(text, "development_base");
  if (!baseline)
    findings.push(
      finding(
        "MISSING_DEVELOPMENT_BASELINE",
        "Flow Decision must define 开发基线.",
      ),
    );
  else if (baselineReason(baseline))
    findings.push(
      finding(
        baselineReason(baseline) === "abstract"
          ? "ABSTRACT_DEVELOPMENT_BASELINE"
          : "INVALID_DEVELOPMENT_BASELINE",
        "Flow Decision 开发基线 must be a concrete branch/ref or commit.",
      ),
    );
  if (ACTIVE_FLOW_TYPES.has(type) && type !== "implement-only") {
    for (const name of [
      "empirical_acceptance",
      "empirical_acceptance_rationale",
      "review_tier",
      "review_rationale",
      "runtime_review_strategy",
      "review_profile_recommendation",
    ]) {
      if (!field(text, name))
        findings.push(
          finding(
            `MISSING_${name.toUpperCase()}`,
            `Flow Decision must define ${name}.`,
          ),
        );
    }
    const reviewTier = field(text, "review_tier");
    if (reviewTier && !/^Tier [1-4]$/.test(reviewTier))
      findings.push(
        finding(
          "INVALID_REVIEW_TIER",
          "review_tier must be Tier 1, Tier 2, Tier 3, or Tier 4.",
        ),
      );
    if (!field(text, "empirical_acceptance"))
      findings.push(
        finding(
          "EMPIRICAL_ACCEPTANCE_DISPOSITION_REQUIRED",
          "Direct plans must explicitly declare empirical_acceptance.",
        ),
      );
    if (!field(text, "review_tier"))
      findings.push(
        finding(
          "FORMAL_REVIEW_TIER_REQUIRED",
          "Direct plans must explicitly declare review_tier.",
        ),
      );
  }
  return type;
}

function validateTaskOrchestration(
  text: string,
  type: string,
  findings: ContractFinding[],
): void {
  const body = section(text, "Task Orchestration");
  if (!body.trim()) {
    findings.push(
      finding(
        "EMPTY_TASK_ORCHESTRATION",
        "Task Orchestration must contain at least one wave and task.",
      ),
    );
    return;
  }
  if (!/^-\s+wave:\s*\d+/m.test(body)) {
    findings.push(
      finding(
        "TASK_ORCHESTRATION_WAVE_MISSING",
        "Task Orchestration must contain a wave.",
      ),
    );
    return;
  }
  const waves = [...body.matchAll(/^\s*-\s+wave:\s*(\d+)\s*$/gm)].map((match) =>
    Number(match[1]),
  );
  if (waves.some((wave, index) => wave !== index + 1))
    findings.push(
      finding(
        "TASK_ORCHESTRATION_WAVE_SEQUENCE_INVALID",
        "Task Orchestration waves must be continuous from 1.",
      ),
    );
  for (const line of body.split(/\r?\n/)) {
    if (!/=>/.test(line) || /^\s*#/.test(line)) continue;
    const task = line.trim();
    const executor = task.match(/^-\s+([^\s=\[]+)/)?.[1];
    if (executor?.startsWith("task-agent:"))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_INVALID_ITEM",
          "task-agent aliases are not valid task executors.",
        ),
      );
    const skill = task.match(/\(skill:\s*([^)]*)\)/)?.[1]?.trim();
    if (!skill)
      findings.push(
        finding(
          "TASK_ORCHESTRATION_MISSING_SKILL_BINDING",
          `Task item requires an inline dollar-prefixed skill binding: ${task}`,
        ),
      );
    else if (
      skill
        .split(/[,+，＋\s]+/)
        .some((item) => item && !/^\$[A-Za-z0-9_-]+$/.test(item))
    )
      findings.push(
        finding(
          "TASK_ORCHESTRATION_SKILL_REF_FORMAT_INVALID",
          `Skill binding must use dollar-prefixed skill names: ${task}`,
        ),
      );
    const expectedSkill = {
      "fast-track": "$fast-flow",
      normal: "$normal-flow",
      "local-merge": "$local-merge-flow",
      "implement-only": "$implement-only-flow",
    }[type];
    if (expectedSkill && skill) {
      const skills = skill.split(/[,+，＋\s]+/).filter(Boolean);
      const topLevel = skills.filter((item) =>
        /^\$(?:fast-flow|normal-flow|local-merge-flow|implement-only-flow)$/.test(
          item,
        ),
      );
      if (topLevel.length !== 1 || topLevel[0] !== expectedSkill)
        findings.push(
          finding(
            "TASK_ORCHESTRATION_FLOW_SKILL_MISMATCH",
            `Task items for ${type} must bind exactly ${expectedSkill}.`,
          ),
        );
    }
    const profile = task.match(/\[([^,\]]+),\s*([^\]]+)\]/);
    if (executor === "main-agent" && profile)
      findings.push(
        finding(
          "MAIN_AGENT_PROFILE_FORBIDDEN",
          "main-agent must not declare an inline profile.",
        ),
      );
    if (executor && executor !== "main-agent" && !profile)
      findings.push(
        finding(
          "TASK_ORCHESTRATION_AGENT_PROFILE_MISSING",
          "sub-agent/task items must declare [model, effort].",
        ),
      );
    if (profile) {
      const model = profile[1]!.trim();
      const effort = profile[2]!.trim();
      const allowedEfforts =
        model === "gpt-6-luna"
          ? new Set(["low", "medium", "high", "xhigh", "max"])
          : model === "gpt-5.6-luna"
            ? new Set(["low", "medium", "high", "xhigh", "max"])
            : new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
      if (
        !/^gpt-[0-9.]+-(?:luna|sol|astra|terra)$/.test(model) ||
        !allowedEfforts.has(effort)
      )
        findings.push(
          finding(
            "TASK_ORCHESTRATION_AGENT_PROFILE_INVALID",
            `Unsupported task profile [${model}, ${effort}].`,
          ),
        );
    }
    if (task.includes("$codex-review-loop"))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_LEGACY_SKILL_FORBIDDEN",
          "Formal review skills must be selected at runtime after readiness.",
        ),
      );
    const taskText = task.includes("=>")
      ? task
          .slice(task.indexOf("=>") + 2)
          .replace(/\(skill:[^)]*\)/gi, "")
          .trim()
      : task;
    if (FORMAL_REVIEW_PREDECLARATION.test(taskText))
      findings.push(
        finding(
          "FORMAL_REVIEW_PREDECLARATION_FORBIDDEN",
          "Task Orchestration may not predeclare a formal reviewer, lane, or review evidence.",
        ),
      );
    if (LEGACY_PROFILE.test(taskText))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_LEGACY_PROFILE_FORBIDDEN",
          "Task items must use [model, effort] instead of legacy profile markers.",
        ),
      );
    if (executor?.startsWith("sub-agent:") && writeIntentForbidden(taskText))
      findings.push(
        finding(
          "SUB_AGENT_SHARED_WRITE_FORBIDDEN",
          "sub-agent tasks must remain read-only.",
        ),
      );
    if (
      !["initiative", "parallel-pr", "wave-thread", "multi-task-flow"].includes(
        type,
      ) &&
      (executor?.startsWith("task:") || executor?.startsWith("task-"))
    )
      findings.push(
        finding(
          "TASK_EXECUTOR_FORBIDDEN_FLOW",
          "task executors are not valid for standalone direct flows.",
        ),
      );
    if (type === "implement-only") {
      if (
        /(?:spec[\s_-]*(?:gate|sync)|spec\s*(?:迁移|同步)|(?:create|generate|init(?:ialize)?|add|update|edit|modify|change|revise|delete|remove|sync|copy|move|rename|write|draft|author|创建|生成|初始化|新增|更新|修改|编辑|删除|移除|同步|复制|移动|重命名|编写|撰写)[^\n]{0,80}(?:docs\/specs|docs\/plan|spec(?:ification)?(?:\.md|\s+document|\s+文档)?))/i.test(
          taskText,
        )
      )
        findings.push(
          finding(
            "IMPLEMENT_ONLY_FORBIDDEN_TASK_IN_ORCHESTRATION",
            "implement-only must not create, migrate, or update Specs.",
          ),
        );
      if (/\(skill:\s*\$(?:topic-spec|normal-flow|fast-flow)\b/i.test(task))
        findings.push(
          finding(
            "IMPLEMENT_ONLY_FORBIDDEN_SKILL",
            "implement-only tasks must use $implement-only-flow.",
          ),
        );
    }
  }
  if (type === "multi-task-flow") return;
  try {
    const [, tasks] = canonicalFacts(text);
    if (!Object.keys(tasks).length)
      findings.push(
        finding(
          "TASK_ORCHESTRATION_TASK_MISSING",
          "Task Orchestration must contain at least one task.",
        ),
      );
  } catch (error) {
    findings.push(
      finding(
        "TASK_ORCHESTRATION_INVALID",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

function validateAcceptance(
  text: string,
  type: string,
  findings: ContractFinding[],
): void {
  const empirical = field(text, "empirical_acceptance");
  if (empirical && !new Set(["required", "not_required"]).has(empirical))
    findings.push(
      finding(
        "EMPIRICAL_ACCEPTANCE_DISPOSITION_REQUIRED",
        "empirical_acceptance must be required or not_required.",
      ),
    );
  const requireEmpirical = empirical === "required";
  try {
    const acceptance = parseAcceptance(text, {
      requirePhase: true,
      requireEmpirical,
    });
    if (type === "fast-track") {
      const preMerge = acceptance.items.filter(
        (item) => item.phase === "pre_merge",
      );
      const combined = preMerge.some((item) => {
        const value = item.assertions.join(",");
        return (
          /(?:live|open)\s+(?:pull request|pr)\s+exists/i.test(value) &&
          /current[- ]head\s+(?:ci\/review|review|facts)|current\s+head\s+ci\/review\s+converge|ci\/review\s+converge/i.test(
            value,
          ) &&
          /step\s*5c\s+ready/i.test(value)
        );
      });
      if (preMerge.length > 0 && !combined)
        findings.push(
          finding(
            "FAST_TRACK_PR_ACCEPTANCE_MISSING",
            "fast-track pre-merge acceptance must bind live PR, current-head review/CI, and Step 5C Ready in one item.",
          ),
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      type === "fast-track" &&
      /phase=`?pre_merge`?/i.test(section(text, "Acceptance & Validation")) &&
      !/(?:live|open)\s+(?:pull request|pr)\s+exists[\s\S]{0,240}(?:current[- ]head|current\s+head)[\s\S]{0,240}(?:ci\/review|review|ci)[\s\S]{0,240}step\s*5c\s+ready/i.test(
        section(text, "Acceptance & Validation"),
      )
    )
      findings.push(
        finding(
          "FAST_TRACK_PR_ACCEPTANCE_MISSING",
          "fast-track pre-merge acceptance must bind live PR, current-head review/CI, and Step 5C Ready in one item.",
        ),
      );
    const code = message.startsWith("empirical ")
      ? "EMPIRICAL_ACCEPTANCE_ASSERTIONS_INVALID"
      : message.startsWith("DIRECT_V1_ACCEPTANCE_")
        ? "ACCEPTANCE_MAPPING_INVALID"
        : "ACCEPTANCE_INVALID";
    findings.push(finding(code, message));
  }
  if (type === "multi-task-flow")
    findings.push(
      finding(
        "DEV_PLAN_MULTI_TASK_FLOW_FORBIDDEN",
        "multi-task-flow is an independent runtime flow and cannot be selected by dev-plan.",
      ),
    );
}

export function historicalDirectFindings(text: string): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const headings = sectionHeadings(text);
  const required = [
    "Summary",
    "Flow Decision",
    "Goals",
    "Non-goals",
    "Task Orchestration",
    "Acceptance & Validation",
    "Assumptions/Defaults",
  ];
  for (const name of required)
    if (!headings.includes(name))
      findings.push(
        finding(
          name === "Task Orchestration"
            ? "MISSING_TASK_ORCHESTRATION_SECTION"
            : name === "Goals"
              ? "MISSING_GOALS_SECTION"
              : name === "Non-goals"
                ? "MISSING_NON_GOALS_SECTION"
                : `MISSING_${name.toUpperCase().replaceAll(/[ /-]/g, "_")}_SECTION`,
          `Historical plan is missing ## ${name}.`,
        ),
      );
  const positions = required.map((name) => headings.indexOf(name));
  if (
    positions.every((position) => position >= 0) &&
    positions.some(
      (position, index) => index > 0 && position <= positions[index - 1]!,
    )
  )
    findings.push(
      finding(
        "SECTION_ORDER_INVALID",
        "Historical plan sections are out of order.",
      ),
    );

  const summary = section(text, "Summary")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (
    headings.includes("Summary") &&
    !summary.some((line) => /^-\s+\S/.test(line))
  )
    findings.push(
      finding("SUMMARY_EMPTY", "Summary must contain a non-empty bullet."),
    );
  const goals = section(text, "Goals").split(/\r?\n/);
  if (headings.includes("Goals")) {
    const goalBullets = goals.filter((line) => /^-\s*/.test(line));
    if (!goalBullets.some((line) => line.replace(/^-\s*/, "").trim()))
      findings.push(
        finding("GOALS_EMPTY", "Goals must contain a non-empty goal."),
      );
    if (goalBullets.some((line) => /^-\s*$/.test(line)))
      findings.push(
        finding("GOAL_TITLE_EMPTY", "Goal bullets must not be empty."),
      );
    for (const [index, line] of goals.entries()) {
      if (!/^-\s+Goal\s+\d+\s*:/.test(line)) continue;
      const next = goals[index + 1] ?? "";
      if (
        next &&
        (/^\s{2,}\S/.test(next) === false || PLACEHOLDER.test(next.trim()))
      )
        findings.push(
          finding(
            "GOAL_DETAIL_MISSING",
            "Each goal needs a concrete detail line.",
          ),
        );
    }
  }
  const nonGoals = section(text, "Non-goals").split(/\r?\n/);
  if (headings.includes("Non-goals")) {
    if (nonGoals.some((line) => /^\s*-\s*$/.test(line)))
      findings.push(
        finding("NON_GOAL_EMPTY", "Non-goal bullets must not be empty."),
      );
    if (nonGoals.some(nonGoalPlaceholder))
      findings.push(
        finding(
          "NON_GOAL_PLACEHOLDER",
          "Non-goal bullets must describe concrete exclusions.",
        ),
      );
  }

  const flow = field(text, "flow_type");
  for (const name of [
    "flow_type",
    "flow_source",
    "lock_status",
    "开发基线",
    "development_base",
  ]) {
    if (historicalFlowFieldValues(text, name).length > 1)
      findings.push(
        finding(
          "DUPLICATE_FLOW_FIELD",
          `Flow Decision field ${name} must appear exactly once.`,
        ),
      );
  }
  if (!flow)
    findings.push(
      finding("MISSING_FLOW_TYPE", "Flow Decision must define flow_type."),
    );
  else if (
    flow === "initiative" ||
    flow === "parallel-pr" ||
    flow === "wave-thread" ||
    !ACTIVE_FLOW_TYPES.has(flow)
  )
    findings.push(
      finding(
        !RETIRED_FLOW_TYPES.has(flow) ||
          /(?:\$?(?:fast-flow|fast-pr-delivery)|\$fast-flow)/i.test(
            section(text, "Task Orchestration"),
          )
          ? "UNKNOWN_FLOW_TYPE"
          : "RETIRED_FLOW_TYPE",
        `flow_type=${flow} is not an active standalone dev-plan flow.`,
      ),
    );
  if (/^\s*-\s*`?delivery_topology`?\s*:/m.test(section(text, "Flow Decision")))
    findings.push(
      finding(
        "LEGACY_ROUTING_FIELD_FORBIDDEN",
        "Historical replay plans must not introduce delivery_topology.",
      ),
    );
  const source = historicalField(text, "flow_source");
  const lock = historicalField(text, "lock_status");
  if (!source)
    findings.push(
      finding("MISSING_FLOW_SOURCE", "Flow Decision must define flow_source."),
    );
  if (!lock)
    findings.push(
      finding("MISSING_LOCK_STATUS", "Flow Decision must define lock_status."),
    );
  else if (lock !== "locked")
    findings.push(
      finding(
        "LOCK_STATUS_NOT_LOCKED",
        "Historical finalized plans require lock_status=locked.",
      ),
    );
  const baseline =
    historicalField(text, "开发基线") ??
    historicalField(text, "development_base");
  if (!baseline)
    findings.push(
      finding(
        "MISSING_DEVELOPMENT_BASELINE",
        "Flow Decision must define 开发基线.",
      ),
    );
  else if (baselineReason(baseline))
    findings.push(
      finding(
        baselineReason(baseline) === "abstract"
          ? "ABSTRACT_DEVELOPMENT_BASELINE"
          : "INVALID_DEVELOPMENT_BASELINE",
        "Flow Decision 开发基线 must be a concrete branch/ref or commit.",
      ),
    );
  const orchestration = section(text, "Task Orchestration");
  if (orchestration) {
    const lines = orchestration.split(/\r?\n/).filter((line) => line.trim());
    if (lines.some((line) => /^\s*(?:-\s*)?\[\s*[xX ]\s*\]\s+/.test(line)))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_CHECKBOX_FORBIDDEN",
          "Historical orchestration does not accept checkbox items.",
        ),
      );
    if (lines.some((line) => !/^\s*-\s+/.test(line) && !/^\s*```/.test(line)))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_NON_LIST_CONTENT",
          "Task Orchestration may contain list items only.",
        ),
      );
    const waves = lines
      .map((line) => line.match(/^\s*-\s+wave:\s*(\d+)\s*$/)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    if (waves.length && waves.some((wave, index) => wave !== index + 1))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_WAVE_SEQUENCE_INVALID",
          "Historical waves must be continuous from 1.",
        ),
      );
    if (!waves.length && lines.some((line) => /=>/.test(line)))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_TASK_OUTSIDE_WAVE",
          "Historical task items must be nested under a wave.",
        ),
      );
    for (let index = 0; index < waves.length; index += 1) {
      const start = lines.findIndex((line) =>
        new RegExp(`^\\s*-\\s+wave:\\s*${waves[index]}\\s*$`).test(line),
      );
      const end =
        index + 1 < waves.length
          ? lines.findIndex(
              (line, lineIndex) =>
                lineIndex > start &&
                new RegExp(`^\\s*-\\s+wave:\\s*${waves[index + 1]}\\s*$`).test(
                  line,
                ),
            )
          : lines.length;
      if (
        start >= 0 &&
        !lines.slice(start + 1, end).some((line) => /=>/.test(line))
      )
        findings.push(
          finding(
            "TASK_ORCHESTRATION_EMPTY_WAVE",
            `Wave ${waves[index]} has no task.`,
          ),
        );
    }
    const taskLines = lines.filter((line) => /=>/.test(line));
    if (taskLines.some((line) => !/\(\s*skill\s*:/i.test(line)))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_MISSING_SKILL_BINDING",
          "Historical task items require a dollar-prefixed skill binding.",
        ),
      );
    else if (
      taskLines.some((line) =>
        [...line.matchAll(/\(\s*skill\s*:\s*([^)]*)\)/gi)].some((match) =>
          match[1]!
            .split(/[,+，＋\s]+/)
            .some((skill) => skill && !/^\$[A-Za-z0-9_-]+$/.test(skill)),
        ),
      )
    )
      findings.push(
        finding(
          "TASK_ORCHESTRATION_SKILL_REF_FORMAT_INVALID",
          "Historical skill bindings must use dollar-prefixed skill names.",
        ),
      );
    const taskKeys = taskLines
      .map((line) => line.match(/^\s*-\s+([^\s=]+).*=>/)?.[1])
      .filter((key): key is string => Boolean(key) && key !== "main-agent");
    if (new Set(taskKeys).size !== taskKeys.length)
      findings.push(
        finding(
          "TASK_ORCHESTRATION_DUPLICATE_TASK_IN_WAVE",
          "Historical task IDs must be unique within a wave.",
        ),
      );
    if (taskLines.some((line) => persistedArtifactForbidden(line)))
      findings.push(
        finding(
          "TASK_ORCHESTRATION_PERSISTED_PLAN_ARTIFACT_FORBIDDEN",
          "Historical orchestration cannot create persisted planning artifacts.",
        ),
      );
    for (const line of taskLines) {
      const executor = line.match(/^\s*-\s+([^\s=\[]+)/)?.[1] ?? "";
      if (/^task-agent:/.test(executor))
        findings.push(
          finding(
            "TASK_ORCHESTRATION_INVALID_ITEM",
            "Historical task-agent aliases are not valid task executors.",
          ),
        );
      const profile = line.match(/\[([^,\]]+),\s*([^\]]+)\]/);
      if (executor === "main-agent" && profile)
        findings.push(
          finding(
            "MAIN_AGENT_PROFILE_FORBIDDEN",
            "main-agent must not declare an inline profile.",
          ),
        );
      else if (executor && executor !== "main-agent" && !profile)
        findings.push(
          finding(
            "TASK_ORCHESTRATION_AGENT_PROFILE_MISSING",
            "sub-agent/task items must declare [model, effort].",
          ),
        );
      else if (profile) {
        const model = profile[1]!.trim();
        const effort = profile[2]!.trim();
        const allowed =
          model === "gpt-6-luna" || model === "gpt-5.6-luna"
            ? new Set(["low", "medium", "high", "xhigh", "max"])
            : new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
        if (
          !/^gpt-[0-9.]+-(?:luna|sol|astra|terra)$/.test(model) ||
          !allowed.has(effort)
        )
          findings.push(
            finding(
              "TASK_ORCHESTRATION_AGENT_PROFILE_INVALID",
              `Unsupported task profile [${model}, ${effort}].`,
            ),
          );
      }
      const taskText = line.includes("=>")
        ? line
            .slice(line.indexOf("=>") + 2)
            .replace(/\(skill:[^)]*\)/gi, "")
            .trim()
        : line;
      if (FORMAL_REVIEW_PREDECLARATION.test(taskText))
        findings.push(
          finding(
            "FORMAL_REVIEW_PREDECLARATION_FORBIDDEN",
            "Task Orchestration may not predeclare a formal reviewer, lane, or review evidence.",
          ),
        );
      if (LEGACY_PROFILE.test(taskText))
        findings.push(
          finding(
            "TASK_ORCHESTRATION_LEGACY_PROFILE_FORBIDDEN",
            "Task items must use [model, effort] instead of legacy profile markers.",
          ),
        );
      if (
        executor.startsWith("sub-agent:") &&
        !/^\s*git\s+(?:apply\s+--(?:check|stat|numstat|summary)|config\s+(?:--get|--list|list)|worktree\s+list|stash\s+(?:list|show))\b/i.test(
          taskText,
        ) &&
        writeIntentForbidden(taskText)
      )
        findings.push(
          finding(
            "SUB_AGENT_SHARED_WRITE_FORBIDDEN",
            "sub-agent tasks must remain read-only.",
          ),
        );
      if (
        ![
          "initiative",
          "parallel-pr",
          "wave-thread",
          "multi-task-flow",
        ].includes(flow ?? "") &&
        (executor.startsWith("task:") || executor.startsWith("task-"))
      )
        findings.push(
          finding(
            "TASK_EXECUTOR_FORBIDDEN_FLOW",
            "task executors are not valid for standalone direct flows.",
          ),
        );
      if ((flow ?? "") === "implement-only") {
        const testReference =
          /(?:test|tests|测试|用例)[^\n]{0,80}(?:existing|现有)?\s*docs\/specs/i.test(
            taskText,
          );
        const implementationReference =
          /(?:using|with|参考|引用)\s+(?:existing|现有)\s+docs\/specs/i.test(
            taskText,
          );
        const forbidden =
          !testReference &&
          !implementationReference &&
          /(?:spec[\s_-]*(?:gate|sync)|spec\s*(?:迁移|同步)|(?:create|generate|init(?:ialize)?|add|update|edit|modify|change|revise|delete|remove|sync|copy|move|rename|write|draft|author|创建|生成|初始化|新增|更新|修改|编辑|删除|移除|同步|复制|移动|重命名|编写|撰写)[^\n]{0,80}(?:docs\/specs|docs\/plan|spec(?:ification)?(?:\.md|\s+document|\s+文档)?))/i.test(
            taskText,
          );
        if (forbidden)
          findings.push(
            finding(
              "IMPLEMENT_ONLY_FORBIDDEN_TASK_IN_ORCHESTRATION",
              "implement-only must not create, migrate, or update Specs.",
            ),
          );
        if (/\(skill:\s*\$(?:topic-spec|normal-flow|fast-flow)\b/i.test(line))
          findings.push(
            finding(
              "IMPLEMENT_ONLY_FORBIDDEN_SKILL",
              "implement-only tasks must use $implement-only-flow.",
            ),
          );
      }
    }
  }

  const acceptance = section(text, "Acceptance & Validation")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!acceptance.length || acceptance.every((line) => /^-\s*$/.test(line)))
    findings.push(
      finding(
        "ACCEPTANCE_EMPTY",
        "Acceptance & Validation must contain a concrete item.",
      ),
    );
  else if (
    acceptance.every((line) =>
      /^(?:tba|todo|tbd|none|n\/a|notes?|follow[- ]?up(?:\s+items?)?|待定|待补充|无)(?:\s|[.!?,;：，。；]|$)/i.test(
        line.replace(/^-\s*/, "").trim(),
      ),
    )
  )
    findings.push(
      finding(
        "ACCEPTANCE_PLACEHOLDER",
        "Acceptance & Validation may not be placeholder-only.",
      ),
    );
  if (/^##\s+Execution Steps\s*$/m.test(text))
    findings.push(
      finding(
        "REDUNDANT_EXECUTION_STEPS_SECTION",
        "Execution Steps is not a historical plan section.",
      ),
    );
  return findings;
}

export function validateCanonicalRawPlan(text: string): ContractFinding[] {
  const findings: ContractFinding[] = [];
  if (text.includes("\0"))
    return [
      finding(
        "DEV_PLAN_INPUT_NUL_FORBIDDEN",
        "plan input must not contain NUL bytes",
      ),
    ];
  if (
    unfencedMarkerLines(text, "<proposed_plan>").length ||
    unfencedMarkerLines(text, "</proposed_plan>").length
  )
    findings.push(
      finding(
        "DEV_PLAN_LEGACY_INPUT_FORBIDDEN",
        "canonical raw-plan input must not contain a proposed_plan wrapper",
      ),
    );
  try {
    validateFencedBlocks(text);
  } catch (error) {
    findings.push(
      finding(
        "DEV_PLAN_FENCED_BLOCK_INVALID",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  validateSectionShape(text, findings);
  if (
    /^##\s+(?:Scope Basis|Authorization sources|Plan Provenance|Provenance|授权来源)\s*$/im.test(
      text,
    )
  )
    findings.push(
      finding(
        "PLAN_PROVENANCE_SECTION_FORBIDDEN",
        "Raw plans must not expose provenance mapping sections.",
      ),
    );
  const constraints = section(text, "Constraints");
  const acceptanceIds = new Set(
    [
      ...section(text, "Acceptance & Validation").matchAll(
        /^-\s+([A-Z][A-Z0-9_-]*)\s+\[/gm,
      ),
    ].map((match) => match[1]),
  );
  for (const match of constraints.matchAll(
    /^\s*-\s*(C\d+)\s*:.*?applies_to\s*=\s*`?([A-Z][A-Z0-9_-]*)`?/gm,
  ))
    if (!acceptanceIds.has(match[2]!))
      findings.push(
        finding(
          "PLAN_CONSTRAINT_ACCEPTANCE_UNKNOWN",
          `Constraint ${match[1]} references unknown acceptance ${match[2]}.`,
        ),
      );
  if (constraints && /(?:^|\n)\s*-\s*C\d+\s*:/m.test(constraints)) {
    const orchestration = section(text, "Task Orchestration");
    for (const match of constraints.matchAll(/^\s*-\s*(C\d+)\s*:/gm))
      if (
        new RegExp(`(?:^|[^A-Za-z0-9_])${match[1]}(?:$|[^A-Za-z0-9_])`).test(
          orchestration,
        )
      )
        findings.push(
          finding(
            "TASK_ORCHESTRATION_CONSTRAINT_REFERENCE_FORBIDDEN",
            `Constraint ${match[1]} must constrain a goal or acceptance, not become an orchestration task.`,
          ),
        );
  }
  const type = validateFlow(text, findings);
  const runtimeStrategy = field(text, "runtime_review_strategy");
  if (
    runtimeStrategy &&
    /(?:unconditionally|without readiness|无条件|不经 readiness|直接启动)/i.test(
      runtimeStrategy,
    )
  )
    findings.push(
      finding(
        "FORMAL_REVIEW_RUNTIME_STRATEGY_INVALID",
        "Formal review lanes must be readiness-gated at runtime.",
      ),
    );
  const profileRecommendation = field(text, "review_profile_recommendation");
  if (
    profileRecommendation &&
    /(?:reviewer|review-agent|policy-semantics|record-integrity|contract-language|regression-evidence|ui-accessibility|security|database-migration|release-infra)\b/i.test(
      profileRecommendation,
    )
  )
    findings.push(
      finding(
        "FORMAL_REVIEW_PROFILE_RECOMMENDATION_INVALID",
        "Review profile recommendations must describe capabilities, not predeclare reviewer identities.",
      ),
    );
  if (
    profileRecommendation &&
    (profileRecommendation.match(
      /gpt-[0-9.]+-(?:luna|sol|astra|terra)\s*\+\s*(?:low|medium|high|xhigh|max|ultra)/gi,
    )?.length ?? 0) > 1
  )
    findings.push(
      finding(
        "FORMAL_REVIEW_PROFILE_RECOMMENDATION_INVALID",
        "Review profile recommendations must not predeclare multiple concrete reviewer profile pairs.",
      ),
    );
  if (
    type === "fast-track" &&
    /(?:avoid\s+(?:(?:opening|opening or reusing|creating|pr delivery)|(?:pr|pull request)\s+(?:creation|delivery|push))|direct\s+pr\s+delivery\s+is\s+omitted|no\s+direct\s+pr\b|no\s+remote\s+delivery|no\s+pr\s*(?:;|,|$)|无需\s*PR|不允许\s*PR\s*创建|直接本地|local-only|remote delivery omitted)/i.test(
      text,
    )
  )
    findings.push(
      finding(
        "FAST_TRACK_PR_FORBIDDEN",
        "fast-track requires direct PR delivery and must not exclude it.",
      ),
    );
  validateTaskOrchestration(text, type ?? "fast-track", findings);
  if (
    section(text, "Task Orchestration")
      .split(/\r?\n/)
      .some((line) => persistedArtifactForbidden(line))
  )
    findings.push(
      finding(
        "TASK_ORCHESTRATION_PERSISTED_PLAN_ARTIFACT_FORBIDDEN",
        "Task Orchestration cannot create persisted planning artifacts.",
      ),
    );
  validateAcceptance(text, type ?? "fast-track", findings);
  const assumptions = section(text, "Assumptions/Defaults");
  if (assumptions && !/(已确定|待确认|未检查)/.test(assumptions))
    findings.push(
      finding(
        "ASSUMPTION_TRI_STATE_MISSING",
        "Assumptions/Defaults items must include 已确定, 待确认, or 未检查.",
      ),
    );
  if (/^##\s+Execution Steps\s*$/m.test(text))
    findings.push(
      finding(
        "REDUNDANT_EXECUTION_STEPS_SECTION",
        "Execution Steps must be merged into Task Orchestration.",
      ),
    );
  return findings;
}

export function canonicalDiagnostic(text: string): string {
  const findings = validateCanonicalRawPlan(text);
  if (!findings.length) return "PASS file=<stdin> checks=ok\n";
  return (
    findings
      .map(
        (item) =>
          `FINDING file=<stdin> idx=raw code=${item.code} msg=${item.message}`,
      )
      .join("\n") + "\n"
  );
}
