import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { gatewayRecoveryPage, gatewayRecoveryScript } from "../../lib/gateway-recovery-page";
import type { WorkerDiagnostic } from "../../lib/worker-diagnostics";

const diagnostic = {
  diagnostic_id: "diag-test",
  run_id: "demo-recovery",
  worker_key: "schema-2/contract-3@build-a",
  worker_generation: "unknown-generation",
  stage: "worker_select",
  error_code: "RUN_WORKER_UNAVAILABLE",
  retry_count: 3,
  state: "degraded",
} as WorkerDiagnostic;

test("run ID selects all on initial focus and permits a later partial selection", () => {
  const dom = new Window();
  dom.document.write(gatewayRecoveryPage({ diagnostic, retry_after_ms: 0 }));
  new Function("document", "performance", "setInterval", "clearInterval", gatewayRecoveryScript)(
    dom.document,
    { now: () => 0 },
    () => 1,
    () => {},
  );
  const input = dom.document.querySelector<HTMLInputElement>("#run-id")!;
  input.focus();
  input.click();
  expect(input.readOnly).toBe(true);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(diagnostic.run_id.length);
  input.dispatchEvent(new dom.PointerEvent("pointermove", { buttons: 1 }));
  input.setSelectionRange(5, 10);
  input.click();
  expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe("recov");
});

test("countdown prevents early retries, never auto-navigates, and a manual retry preserves the complete location", () => {
  const dom = new Window({
    url: "http://localhost/runs/demo-recovery/?plan=a&tab=timeline#task-one",
  });
  dom.document.write(gatewayRecoveryPage({ diagnostic, retry_after_ms: 2_000 }));
  let now = 0;
  let tick = () => {};
  let reloads = 0;
  const location = {
    reload: () => {
      reloads += 1;
    },
  };
  new Function(
    "document",
    "performance",
    "setInterval",
    "clearInterval",
    "location",
    gatewayRecoveryScript,
  )(
    dom.document,
    { now: () => now },
    (callback: () => void) => {
      tick = callback;
      return 1;
    },
    () => {},
    location,
  );
  const retry = dom.document.querySelector<HTMLButtonElement>("#retry")!;
  expect(retry.disabled).toBe(true);
  expect(dom.document.querySelector("#retry-seconds")?.textContent).toBe("2");
  retry.dispatchEvent(new dom.Event("click"));
  expect(reloads).toBe(0);
  now = 2_000;
  tick();
  expect(retry.disabled).toBe(false);
  expect(dom.document.querySelector<HTMLElement>("#retry-countdown")?.hidden).toBe(true);
  expect(reloads).toBe(0);
  retry.click();
  expect(reloads).toBe(1);
  expect(retry.disabled).toBe(true);
  tick();
  retry.dispatchEvent(new dom.Event("click"));
  expect(reloads).toBe(1);
  expect(dom.location.href).toBe(
    "http://localhost/runs/demo-recovery/?plan=a&tab=timeline#task-one",
  );
});

test("copy failure leaves diagnostic text selected for manual copying", async () => {
  const dom = new Window();
  dom.document.write(gatewayRecoveryPage({ diagnostic, retry_after_ms: 0 }));
  new Function(
    "document",
    "performance",
    "setInterval",
    "clearInterval",
    "navigator",
    gatewayRecoveryScript,
  )(
    dom.document,
    { now: () => 0 },
    () => 1,
    () => {},
    {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    },
  );
  dom.document.querySelector<HTMLButtonElement>("#copy")!.click();
  await Promise.resolve();
  await Promise.resolve();
  const field = dom.document.querySelector<HTMLTextAreaElement>("#copy-fallback")!;
  expect(field.hidden).toBe(false);
  expect(JSON.parse(field.value).diagnostic.diagnostic_id).toBe("diag-test");
  expect(field.selectionEnd).toBe(field.value.length);
  expect(dom.document.querySelector("#copy-status")?.textContent).toContain("无法自动复制");
});

test("run ID copy uses only the ID and exposes a selected fallback when clipboard access is denied", async () => {
  const dom = new Window();
  dom.document.write(gatewayRecoveryPage({ diagnostic, retry_after_ms: 0 }));
  let copied = "";
  let denied = false;
  new Function(
    "document",
    "performance",
    "setInterval",
    "clearInterval",
    "navigator",
    gatewayRecoveryScript,
  )(
    dom.document,
    { now: () => 0 },
    () => 1,
    () => {},
    {
      clipboard: {
        writeText: async (value: string) => {
          if (denied) throw new Error("denied");
          copied = value;
        },
      },
    },
  );
  const button = dom.document.querySelector<HTMLButtonElement>("#copy-run")!;
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(copied).toBe(diagnostic.run_id);
  expect(button.getAttribute("aria-label")).toBe("已复制编排 ID");
  expect(button.querySelector<HTMLElement>(".copied-icon")?.hidden).toBe(false);
  denied = true;
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(dom.document.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
  const field = dom.document.querySelector<HTMLTextAreaElement>("#copy-fallback")!;
  expect(field.value).toBe(diagnostic.run_id);
  expect(field.selectionEnd).toBe(field.value.length);
  expect(field.hidden).toBe(false);
});
