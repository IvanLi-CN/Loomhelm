import { expect, test } from "bun:test";
import { createProfileEditor } from "../../web/profile-editor";

const profile = { model: "gpt-6.1-sol", thinking: "medium" };
const capabilities = [{ model: "gpt-6.1-sol", thinking: ["medium", "high"] }];

test("compact profile popover closes on outside interaction and Escape without saving", async () => {
  let updates = 0;
  const editor = createProfileEditor(
    {
      capabilities,
      update: async () => {
        updates++;
      },
    },
    "task",
    "a",
    profile,
    profile,
    null,
    null,
    true,
  );
  document.body.append(editor);
  const dropdown = editor.querySelector("details")!;
  const trigger = editor.querySelector<HTMLElement>("summary")!;
  const panel = editor.querySelector<HTMLElement>('.profile-panel[role="dialog"]')!;
  expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
  dropdown.open = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
  expect(dropdown.open).toBe(false);
  dropdown.open = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(dropdown.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(updates).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  editor.remove();
});

test("editor submits a full pair and keeps server failures visible", async () => {
  let received: unknown;
  const editor = createProfileEditor(
    {
      capabilities,
      update: async (...args) => {
        received = args;
        throw new Error("Ledger version changed");
      },
    },
    "task",
    "a",
    profile,
    profile,
    null,
  );
  document.body.append(editor);
  (editor.querySelector(".profile-save") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toEqual(["task", "a", profile, false]);
  expect(editor.querySelector('[role="alert"]')?.textContent).toBe("Ledger version changed");
  editor.remove();
});

test("unavailable capabilities disable mutation and frozen profiles have no edit controls", () => {
  const unavailable = createProfileEditor(
    { capabilities: null, capabilityError: "Catalog unavailable", update: async () => {} },
    "task",
    "a",
    profile,
    profile,
    null,
  );
  expect((unavailable.querySelector(".profile-save") as HTMLButtonElement).disabled).toBe(true);
  expect(unavailable.textContent).toContain("Catalog unavailable");
  const frozen = createProfileEditor(
    { capabilities, update: async () => {} },
    "task",
    "a",
    profile,
    profile,
    "对话创建请求已提交，须先对账",
  );
  expect(frozen.querySelector("select")).toBeNull();
  expect(frozen.textContent).toContain("须先对账");
});

test("run default inheritance is selected and cleared as one pair", async () => {
  let received: unknown;
  const editor = createProfileEditor(
    {
      capabilities,
      update: async (...args) => {
        received = args;
      },
    },
    "task",
    "a",
    null,
    profile,
    null,
  );
  expect((editor.querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(true);
  (editor.querySelector(".profile-save") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toEqual(["task", "a", null, false]);
});

test("run profile uses a neutral settings icon trigger", () => {
  const editor = createProfileEditor(
    { capabilities, update: async () => {} },
    "run",
    "run",
    profile,
    profile,
    null,
  );
  const trigger = editor.querySelector<HTMLElement>(".profile-trigger")!;
  expect(trigger.textContent?.trim()).toBe("");
  expect(trigger.dataset.profileStatus).toBeUndefined();
  expect(trigger.dataset.tooltip).toBe("默认执行配置");
  expect(trigger.querySelector('[data-lucide="settings-2"]')).not.toBeNull();
});

test("profile dropdown uses a model list and discrete thinking slider", async () => {
  let received: unknown;
  const editor = createProfileEditor(
    {
      capabilities,
      update: async (...args) => {
        received = args;
      },
    },
    "task",
    "a",
    profile,
    profile,
    null,
  );
  expect(editor.querySelector("details")?.open).toBe(false);
  expect(editor.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(1);
  const slider = editor.querySelector('input[type="range"]') as HTMLInputElement;
  slider.value = "1";
  slider.dispatchEvent(new Event("input"));
  expect(slider.getAttribute("aria-valuetext")).toBe("high");
  (editor.querySelector(".profile-save") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toEqual(["task", "a", { model: profile.model, thinking: "high" }, false]);
});

test("inheritance cannot submit a default pair absent from the capability catalog", () => {
  const editor = createProfileEditor(
    { capabilities: [], update: async () => {} },
    "task",
    "a",
    null,
    profile,
    null,
  );
  expect((editor.querySelector(".profile-save") as HTMLButtonElement).disabled).toBe(true);
});

test("model menu supports keyboard selection and Escape without closing the profile panel", () => {
  const editor = createProfileEditor(
    {
      capabilities: [...capabilities, { model: "gpt-6-luna", thinking: ["medium"] }],
      update: async () => {},
    },
    "task",
    "a",
    profile,
    profile,
    null,
  );
  document.body.append(editor);
  const details = editor.querySelector("details")!;
  details.open = true;
  const trigger = editor.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
  trigger.click();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const list = editor.querySelector<HTMLElement>('[role="listbox"]')!;
  const selected = list.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
  selected.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  expect(document.activeElement?.textContent).toBe("gpt-6-luna");
  (document.activeElement as HTMLButtonElement).click();
  expect(trigger.textContent).toBe("gpt-6-luna");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  trigger.click();
  list.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.activeElement).toBe(trigger);
  expect(details.open).toBe(true);
  editor.remove();
});
