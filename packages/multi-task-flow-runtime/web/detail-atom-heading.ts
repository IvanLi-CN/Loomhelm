import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  createElement,
  LoaderCircle,
} from "lucide";
import { stateLabel } from "./labels";
import type { AtomicTask } from "./model";
import { attachTooltip } from "./tooltip";

export function atomHeading(atom: AtomicTask): HTMLElement {
  const header = document.createElement("div");
  header.className = "detail-atom-heading";
  const title = document.createElement("h4");
  title.className = "detail-atom-title";
  title.textContent = atom.title;
  const status = document.createElement("button");
  status.type = "button";
  status.className = "detail-atom-status task-row-status-icon";
  status.dataset.state = atom.status;
  const icon = {
    planned: CircleDashed,
    running: LoaderCircle,
    completed: CircleCheck,
    blocked: CircleAlert,
  }[atom.status];
  status.append(createElement(icon ?? CircleHelp, { "aria-hidden": "true" }));
  const label = `原子任务状态：${icon ? stateLabel(atom.status) : `未知（${atom.status}）`}`;
  header.append(title, status, attachTooltip(status, label, label));
  return header;
}
