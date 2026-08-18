import type { RpcTransport } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withKaminoRpcTimeout } from "./rpc";

type RpcRequest = Parameters<RpcTransport>[0];

const request = {
  payload: { id: "1", jsonrpc: "2.0", method: "getSlot", params: [] },
} as unknown as RpcRequest;

afterEach(() => {
  vi.useRealTimers();
});

describe("withKaminoRpcTimeout", () => {
  it("aborts a stalled transport at the package deadline", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const stalled: RpcTransport = async <TResponse>(config: RpcRequest) => {
      observedSignal = config.signal;
      return await new Promise<TResponse>((_resolve, reject) => {
        config.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true }
        );
      });
    };

    const result = withKaminoRpcTimeout(stalled, 25)<unknown>(request);
    const rejected = expect(result).rejects.toThrow("Kamino RPC request timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps the package deadline when the caller also supplies a signal", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const stalled: RpcTransport = async <TResponse>(config: RpcRequest) =>
      await new Promise<TResponse>((_resolve, reject) => {
        config.signal?.addEventListener("abort", () => reject(config.signal?.reason), {
          once: true,
        });
      });

    const result = withKaminoRpcTimeout(
      stalled,
      25
    )<unknown>({
      ...request,
      signal: caller.signal,
    });
    const rejected = expect(result).rejects.toThrow("Kamino RPC request timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(caller.signal.aborted).toBe(false);
  });

  it("preserves caller cancellation instead of relabelling it as a timeout", async () => {
    const caller = new AbortController();
    const callerReason = new Error("request cancelled by caller");
    const stalled: RpcTransport = async <TResponse>(config: RpcRequest) =>
      await new Promise<TResponse>((_resolve, reject) => {
        config.signal?.addEventListener("abort", () => reject(config.signal?.reason), {
          once: true,
        });
      });

    const result = withKaminoRpcTimeout(
      stalled,
      30_000
    )<unknown>({
      ...request,
      signal: caller.signal,
    });
    caller.abort(callerReason);

    await expect(result).rejects.toBe(callerReason);
  });

  it("does not relabel an upstream failure as a timeout", async () => {
    const upstream = new Error("429 Too Many Requests");
    const transport = vi.fn(async () => {
      throw upstream;
    }) as unknown as RpcTransport;

    await expect(withKaminoRpcTimeout(transport, 30_000)<unknown>(request)).rejects.toBe(upstream);
  });
});
