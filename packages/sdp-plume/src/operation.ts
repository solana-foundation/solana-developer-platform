import { AsyncLocalStorage } from "node:async_hooks";

/** Per-operation guard: concurrent position reads never share a mutable deadline. */
const activeOperation = new AsyncLocalStorage<() => void>();
export type PlumeOperationRunner = <T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
) => Promise<T>;
export function withPlumeOperation<T>(
  assertActive: () => void,
  operation: () => Promise<T>
): Promise<T> {
  return activeOperation.run(assertActive, operation);
}
export function assertPlumeOperationActive(): void {
  activeOperation.getStore()?.();
}
