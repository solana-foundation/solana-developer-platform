import { withMinimumRpcSlot } from "@sdp/rpc/read-context";
import type { RpcTransport } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VEDA_BLOCK_TIME_TTL_MS, withVedaReadDeduplication, withVedaRpcTimeout } from "./rpc";

/**
 * The position-read transport's de-duplication, against a fake transport that
 * records every request it is asked to send and settles only when told to.
 */

interface SentRequest {
  payload: { method: string; params: unknown[] };
  signal: AbortSignal | undefined;
  resolve: (response: unknown) => void;
}

function fakeTransport() {
  const sent: SentRequest[] = [];
  const transport = (<TResponse>(config: Parameters<RpcTransport>[0]) =>
    new Promise<TResponse>((resolve, reject) => {
      config.signal?.addEventListener("abort", () => reject(config.signal?.reason), {
        once: true,
      });
      sent.push({
        payload: config.payload as SentRequest["payload"],
        signal: config.signal,
        resolve: resolve as (response: unknown) => void,
      });
    })) as RpcTransport;
  return { sent, transport };
}

let nextId = 0;
function request(method: string, params: unknown[], signal?: AbortSignal) {
  nextId += 1;
  return { payload: { id: String(nextId), jsonrpc: "2.0", method, params }, signal };
}

const ACCOUNTS = ["11111111111111111111111111111111"];
/** A later macrotask: past the one-microtask window kit's own coalescer covers. */
const laterTask = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withVedaReadDeduplication", () => {
  it("shares one in-flight response among identical requests", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);

    const first = read(
      request("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed", encoding: "base64" }])
    );
    await laterTask();
    // Same params in a different key order: still the same request.
    const second = read(
      request("getMultipleAccounts", [ACCOUNTS, { encoding: "base64", commitment: "confirmed" }])
    );
    expect(sent).toHaveLength(1);

    const response = { jsonrpc: "2.0", result: { context: { slot: 9n }, value: [null] } };
    sent[0]?.resolve(response);
    await expect(first).resolves.toBe(response);
    await expect(second).resolves.toBe(response);
  });

  it("keeps requests apart when any param differs", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);

    void read(request("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed" }]));
    void read(
      request("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed", minContextSlot: 7 }])
    );
    void read(request("getAccountInfo", [ACCOUNTS[0], { commitment: "confirmed" }]));

    expect(sent).toHaveLength(3);
  });

  it("re-sends an account read once the earlier one has settled", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);

    const first = read(request("getMultipleAccounts", [ACCOUNTS]));
    sent[0]?.resolve({ jsonrpc: "2.0", result: { context: { slot: 1n }, value: [null] } });
    await first;
    void read(request("getMultipleAccounts", [ACCOUNTS]));

    expect(sent).toHaveLength(2);
  });

  it("remembers a slot's block time, never an error or a null", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);

    const known = read(request("getBlockTime", [5]));
    sent[0]?.resolve({ jsonrpc: "2.0", result: 1_800_000_000n });
    await known;
    await expect(read(request("getBlockTime", [5]))).resolves.toMatchObject({
      result: 1_800_000_000n,
    });
    expect(sent).toHaveLength(1);

    const missing = read(request("getBlockTime", [6]));
    sent[1]?.resolve({ jsonrpc: "2.0", result: null });
    await missing;
    const failed = read(request("getBlockTime", [7]));
    sent[2]?.resolve({ jsonrpc: "2.0", error: { code: -32004, message: "Block not available" } });
    await failed;
    void read(request("getBlockTime", [6]));
    void read(request("getBlockTime", [7]));
    expect(sent).toHaveLength(5);
  });

  it("forgets a block time after its window", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    const known = read(request("getBlockTime", [5]));
    sent[0]?.resolve({ jsonrpc: "2.0", result: 1_800_000_000n });
    await known;
    clock.mockReturnValue(now + VEDA_BLOCK_TIME_TTL_MS + 1);
    void read(request("getBlockTime", [5]));

    expect(sent).toHaveLength(2);
  });

  it("rejects an abandoning consumer with its own reason and serves the rest", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);
    const leaving = new AbortController();
    const reason = new Error("caller gave up");

    const abandoned = read(request("getMultipleAccounts", [ACCOUNTS], leaving.signal));
    const kept = read(request("getMultipleAccounts", [ACCOUNTS], new AbortController().signal));
    leaving.abort(reason);

    await expect(abandoned).rejects.toBe(reason);
    expect(sent[0]?.signal?.aborted).toBe(false);
    const response = { jsonrpc: "2.0", result: { context: { slot: 3n }, value: [null] } };
    sent[0]?.resolve(response);
    await expect(kept).resolves.toBe(response);
  });

  it("aborts the shared request once every consumer has left", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);
    const one = new AbortController();
    const two = new AbortController();

    const first = read(request("getMultipleAccounts", [ACCOUNTS], one.signal));
    const second = read(request("getMultipleAccounts", [ACCOUNTS], two.signal));
    one.abort(new Error("one"));
    two.abort(new Error("two"));
    await expect(first).rejects.toThrow("one");
    await expect(second).rejects.toThrow("two");

    expect(sent[0]?.signal?.aborted).toBe(true);
    // A later identical request starts afresh rather than joining the aborted one.
    void read(request("getMultipleAccounts", [ACCOUNTS]));
    expect(sent).toHaveLength(2);
  });

  it("never shares a minimum-slot balance read with an unscoped read", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaRpcTimeout(withVedaReadDeduplication(transport));
    const config = { commitment: "confirmed", encoding: "base64" };

    const scoped = withMinimumRpcSlot(100, () =>
      read(request("getMultipleAccounts", [ACCOUNTS, config]))
    );
    const unscoped = read(request("getMultipleAccounts", [ACCOUNTS, config]));
    await laterTask();

    expect(sent).toHaveLength(2);
    expect(sent.map((entry) => entry.payload.params[1])).toEqual([
      { ...config, minContextSlot: 100 },
      config,
    ]);
    for (const entry of sent) {
      entry.resolve({ jsonrpc: "2.0", result: { context: { slot: 150n }, value: [null] } });
    }
    await expect(scoped).resolves.toBeDefined();
    await expect(unscoped).resolves.toBeDefined();
  });
});
