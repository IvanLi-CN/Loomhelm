// Disposable invocation fixture: no real native provider or default data root.
import {
  executeInvocation,
  invocationSignal,
  registerInvocationResource,
} from "../../lib/invocation-journal";
import { LedgerStore } from "../../lib/store";

const input = JSON.parse(await Bun.stdin.text());
const store = new LedgerStore(input.root, input.run_id);
await executeInvocation(store, "fixture-wait", {}, async () => {
  const resource = registerInvocationResource("fixture-wait", { request_id: input.request_id });
  process.send?.({ type: "ready" });
  await new Promise<void>((resolve) =>
    invocationSignal()!.addEventListener("abort", () => resolve(), { once: true }),
  );
  resource.end({ fixture_joined: true });
});
