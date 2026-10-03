import { AsyncLocalStorage } from "node:async_hooks";
import type { RpcTransport } from "@solana/kit";

const reads = new AsyncLocalStorage<{
  minimumSlot: number;
  observations: number;
  stale: boolean;
}>();
const contextMethods = new Map([
  ["getAccountInfo", 1],
  ["getMultipleAccounts", 1],
  ["getBalance", 1],
  ["getProgramAccounts", 1],
  ["getTokenAccountsByOwner", 2],
  ["getTokenAccountsByDelegate", 2],
  ["getTokenAccountBalance", 1],
  ["getTokenSupply", 1],
]);
const acceptsMinimumSlot = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getTokenAccountsByOwner",
  "getTokenAccountsByDelegate",
  "getProgramAccounts",
  "getSlot",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Scope a balance read to chain state at or after an observed confirmation. */
export function withMinimumRpcSlot<T>(minimumSlot: number, read: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(minimumSlot) || minimumSlot < 0) {
    throw new Error("Invalid minimum RPC context slot");
  }
  return reads.run({ minimumSlot, observations: 0, stale: false }, async () => {
    const value = await read();
    if (reads.getStore()?.stale || reads.getStore()?.observations === 0) {
      throw new Error("Balance read did not establish its RPC context slot");
    }
    return value;
  });
}

/** Only scoped balance reads change commitment; execution and history do not. */
export function prepareRpcRead(payload: unknown): unknown {
  const context = reads.getStore();
  if (context && Array.isArray(payload)) {
    context.stale = true;
    throw new Error("Batched RPC balance reads require individual context validation");
  }
  const request = record(payload);
  if (!context || typeof request?.method !== "string") return payload;
  const index =
    request.method === "getSlot"
      ? 0
      : request.method === "getProgramAccounts"
        ? 1
        : contextMethods.get(request.method);
  if (index === undefined || !Array.isArray(request.params)) return payload;
  const params: unknown[] = [...request.params];
  const config = record(params[index]);
  params[index] = {
    ...config,
    commitment: "confirmed",
    ...(request.method === "getProgramAccounts" ? { withContext: true } : {}),
    ...(acceptsMinimumSlot.has(request.method) ? { minContextSlot: context.minimumSlot } : {}),
  };
  return { ...request, params };
}

/** Validate the returned bank even when the RPC accepts minContextSlot. */
export function observeRpcRead(payload: unknown, response: unknown): void {
  const context = reads.getStore();
  const method = record(payload)?.method;
  if (
    !context ||
    typeof method !== "string" ||
    (!contextMethods.has(method) && method !== "getSlot")
  )
    return;
  const envelope = record(response);
  if (envelope?.error !== undefined) {
    context.stale = true;
    return;
  }
  const slot =
    method === "getSlot" ? envelope?.result : record(record(envelope?.result)?.context)?.slot;
  const observed = typeof slot === "bigint" ? Number(slot) : slot;
  if (
    !Number.isSafeInteger(observed) ||
    typeof observed !== "number" ||
    observed < context.minimumSlot
  ) {
    context.stale = true;
    throw new Error("RPC balance read is behind the confirmed transaction slot");
  }
  if (method !== "getSlot") context.observations += 1;
}

/** Verify the context on the wire without changing the SDK's requested result shape. */
function restoreRpcResponse(payload: unknown, response: unknown): unknown {
  const request = record(payload);
  if (!reads.getStore() || request?.method !== "getProgramAccounts") return response;
  const config = Array.isArray(request.params) ? record(request.params[1]) : undefined;
  if (config?.withContext === true) return response;
  const envelope = record(response);
  const result = record(envelope?.result);
  return Array.isArray(result?.value) ? { ...envelope, result: result.value } : response;
}

/** web3.js accepts a fetch seam; kit and direct JSON clients use the helpers above. */
export const contextAwareRpcFetch: typeof fetch = async (input, init) => {
  if (!reads.getStore() || typeof init?.body !== "string") return fetch(input, init);
  const originalPayload: unknown = JSON.parse(init.body);
  const payload = prepareRpcRead(originalPayload);
  try {
    const response = await fetch(input, { ...init, body: JSON.stringify(payload) });
    if (response.ok) {
      const body: unknown = await response.clone().json();
      observeRpcRead(payload, body);
      const restored = restoreRpcResponse(originalPayload, body);
      if (restored !== body) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(JSON.stringify(restored), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } else {
      const context = reads.getStore();
      if (context) context.stale = true;
    }
    return response;
  } catch (error) {
    const context = reads.getStore();
    if (context) context.stale = true;
    throw error;
  }
};

/** Server-only middleware; the shared Solana client also serves browser callers. */
export function withRpcReadContext(transport: RpcTransport): RpcTransport {
  return async <T>(request: Parameters<RpcTransport>[0]) => {
    const payload = prepareRpcRead(request.payload);
    try {
      const response = await transport<T>({ ...request, payload });
      observeRpcRead(payload, response);
      return restoreRpcResponse(request.payload, response) as T;
    } catch (error) {
      const context = reads.getStore();
      if (context) context.stale = true;
      throw error;
    }
  };
}
