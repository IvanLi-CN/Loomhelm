import { menuChevron, profileModelMenu } from "./profile-model-menu";
export type ExecutionProfile = { model: string; thinking: string };
export type ProfileCapabilities = { model: string; thinking: string[] }[];
export type ProfileTarget = "task" | "group" | "run";
export type ProfileEditorContext = {
  capabilities: ProfileCapabilities | null;
  capabilityError?: string;
  update: (target: ProfileTarget, id: string, profile: ExecutionProfile | null, recommend?: boolean) => Promise<void>;
};

export function createProfileEditor(context: ProfileEditorContext, target: ProfileTarget, id: string, current: ExecutionProfile | null, effective: ExecutionProfile | null, freezeReason: string | null, recommendation: string | null = null): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "execution-profile-editor";
  if (freezeReason) {
    const value = document.createElement("p"); value.className = "profile-caption";
    value.textContent = effective ? `${effective.model} · ${effective.thinking}` : "执行配置待迁移";
    const reason = document.createElement("p"); reason.className = "profile-caption"; reason.textContent = `只读：${freezeReason}`;
    wrapper.append(value, reason); return wrapper;
  }
  const dropdown = document.createElement("details"); dropdown.className = "profile-dropdown";
  const trigger = document.createElement("summary"); trigger.className = "profile-trigger";
  trigger.setAttribute("aria-label", target === "run" ? "默认执行配置" : "编辑执行配置");
  trigger.textContent = target === "run" ? "默认执行配置" : effective ? `${effective.model} · ${effective.thinking}` : "选择模型与思考强度";
  trigger.append(menuChevron());
  const panel = document.createElement("div"); panel.className = "profile-panel";
  const caption = document.createElement("p"); caption.className = "profile-caption";
  caption.textContent = target === "run" ? "用于没有独立配置的新对话。" : current ? "当前对象使用独立配置。" : "当前对象使用运行默认值。";
  panel.append(caption);
  if (recommendation) { const reason = document.createElement("p"); reason.className = "profile-caption"; reason.textContent = recommendation; panel.append(reason); }
  const options = (context.capabilities ?? []).map((item) => ({ value: item.model, label: item.model }));
  if (target !== "run") options.unshift({ value: "", label: "使用运行默认值" });
  if (current && !options.some((item) => item.value === current.model)) options.push({ value: current.model, label: `${current.model}（不可用）` });
  const model = profileModelMenu(target === "run" ? "运行默认模型" : "模型", options, current?.model ?? (target === "run" ? effective?.model ?? "" : ""), () => { error.textContent = ""; populateThinking(chosenThinking() || effective?.thinking); });
  const label = document.createElement("div"); label.className = "profile-model-field";
  const modelLabel = document.createElement("span"); modelLabel.textContent = "模型"; label.append(modelLabel, model.root);
  const thinking = document.createElement("input"); thinking.type = "range"; thinking.min = "0"; thinking.step = "1";
  thinking.setAttribute("aria-label", target === "run" ? "运行默认思考强度" : "思考强度");
  const strengthLabel = document.createElement("div"); strengthLabel.className = "profile-strength-label"; strengthLabel.append("思考强度");
  const strengthValue = document.createElement("output"); strengthLabel.append(strengthValue);
  const save = document.createElement("button"); save.type = "button"; save.className = "profile-save"; save.textContent = "保存配置";
  const recommend = document.createElement("button"); recommend.type = "button"; recommend.className = "profile-recommend"; recommend.textContent = "重新应用推荐";
  const error = document.createElement("p"); error.className = "profile-error"; error.setAttribute("role", "alert"); error.textContent = context.capabilityError ?? "";
  let levels: string[] = [];
  let busy = false;
  const chosenThinking = () => levels[Number(thinking.value)] ?? "";
  const validate = () => {
    const inherited = model.value === "" && target !== "run";
    const valid = inherited ? !!effective && !!context.capabilities?.some((item) => item.model === effective.model && item.thinking.includes(effective.thinking)) : !!context.capabilities?.some((item) => item.model === model.value && item.thinking.includes(chosenThinking()));
    save.disabled = busy || !context.capabilities || !valid;
    recommend.disabled = busy || !context.capabilities;
    thinking.disabled = busy || inherited || !context.capabilities || levels.length < 2;
    model.disabled = busy || !context.capabilities;
    strengthValue.textContent = chosenThinking() || "不可用";
    thinking.setAttribute("aria-valuetext", chosenThinking() || "不可用");
    thinking.style.setProperty("--profile-progress", `${levels.length > 1 ? Number(thinking.value) / (levels.length - 1) * 100 : 0}%`);
  };
  const populateThinking = (selected?: string) => {
    levels = context.capabilities?.find((item) => item.model === (model.value || effective?.model))?.thinking ?? [];
    thinking.max = String(Math.max(0, levels.length - 1));
    thinking.value = String(Math.max(0, levels.indexOf(selected ?? "")));
    validate();
  };
  populateThinking(current?.thinking ?? effective?.thinking);
  thinking.addEventListener("input", validate);
  const submit = async (reapply: boolean) => {
    busy = true; error.textContent = ""; validate();
    try {
      await context.update(target, id, model.value ? { model: model.value, thinking: chosenThinking() } : null, reapply);
      dropdown.open = false;
    } catch (cause) { error.textContent = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; validate(); }
  };
  save.addEventListener("click", () => { void submit(false); });
  recommend.addEventListener("click", () => { void submit(true); });
  dropdown.addEventListener("keydown", (event) => { if (event.key === "Escape" && dropdown.open) { event.stopPropagation(); dropdown.open = false; trigger.focus(); } });
  const actions = document.createElement("div"); actions.className = "profile-actions";
  if (target !== "run") actions.append(recommend);
  actions.append(save);
  panel.append(label, strengthLabel, thinking, actions);
  panel.append(error); dropdown.append(trigger, panel); wrapper.append(dropdown);
  return wrapper;
}
