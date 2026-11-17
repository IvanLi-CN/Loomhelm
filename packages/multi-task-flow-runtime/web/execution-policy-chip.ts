import {
  Bot,
  CircleDashed,
  CircleHelp,
  createElement,
  FileCheck,
  GitPullRequest,
  Minus,
  Share2,
  TriangleAlert,
  UserRound,
  UsersRound,
} from "lucide";
import { deriveExecutionPolicy } from "./execution-policy-model";
import { attachTooltip } from "./tooltip";

function raw(value: unknown): string {
  if (value === undefined) return "undefined（字段缺失）";
  if (value === null) return "null（未声明）";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function chip(
  label: string,
  icon: typeof Bot,
  values: Record<string, unknown>,
  reason = "",
): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "detail-policy-value";
  const trigger = document.createElement("span");
  trigger.className = "detail-policy-trigger";
  trigger.tabIndex = 0;
  trigger.append(createElement(icon, { "aria-hidden": "true" }), document.createTextNode(label));
  const content = document.createElement("div");
  content.className = "detail-policy-tooltip";
  for (const [key, value] of Object.entries(values)) {
    const line = document.createElement("div");
    line.textContent = `${key}: ${raw(value)}`;
    content.append(line);
  }
  if (reason) {
    const line = document.createElement("div");
    line.textContent = reason;
    content.append(line);
  }
  wrapper.append(
    trigger,
    attachTooltip(
      trigger,
      content,
      `${label}；${[...content.children].map((line) => line.textContent).join("；")}`,
    ),
  );
  return wrapper;
}

export function executionPolicyChip(owner: unknown, conversation: unknown): HTMLElement {
  const state = deriveExecutionPolicy(owner, conversation);
  const icon = {
    main: UserRound,
    delivery_agent: UsersRound,
    task_agent: Bot,
    undeclared: CircleDashed,
    incomplete: TriangleAlert,
    conflict: TriangleAlert,
    unknown: CircleHelp,
  }[state.state];
  const result = chip(
    state.label,
    icon,
    { execution_owner: owner, conversation_policy: conversation },
    state.reason,
  );
  result.dataset.policyState = state.state;
  return result;
}

export function deliveryPolicyChip(policy: unknown): HTMLElement {
  const options = {
    parent_pr: ["父 PR", GitPullRequest],
    child_pr: ["子 PR", GitPullRequest],
    shared_delivery_unit: ["共享交付", Share2],
    evidence: ["验收证据", FileCheck],
    none: ["无交付产物", Minus],
  } as const;
  const known = typeof policy === "string" ? options[policy as keyof typeof options] : undefined;
  return chip(
    known?.[0] ?? (policy === null ? "交付未声明" : "交付待确认"),
    known?.[1] ?? CircleHelp,
    { delivery_policy: policy },
  );
}
