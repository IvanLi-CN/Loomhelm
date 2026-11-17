import { AsyncLocalStorage } from "node:async_hooks";

type NativeOperation = { id: string; source: "archive" | "unarchive"; task_id: string };
const context = new AsyncLocalStorage<NativeOperation>();
export const nativeOperation = () => context.getStore();
export function withNativeOperation<T>(operation: NativeOperation, action: () => Promise<T>) {
  return context.run(operation, action);
}
