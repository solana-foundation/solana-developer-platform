import { readStamp, withMinimumRpcSlot, withReadFloor } from "@sdp/rpc/read-context";
import { address, type Base64EncodedWireTransaction, type RpcTransport } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKaminoReadRpc,
  createKaminoRpc,
  withKaminoReadDeduplication,
  withKaminoRpcTimeout,
} from "./rpc";

type RpcRequest = Parameters<RpcTransport>[0];

const request = {
  payload: { id: "1", jsonrpc: "2.0", method: "getSlot", params: [] },
} as unknown as RpcRequest;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("withKaminoRpcTimeout", () => {
  it("rejects an older bank through the actual SDK transport boundary", async () => {
    const accountRequest = {
      payload: {
        id: "1",
        jsonrpc: "2.0",
        method: "getMultipleAccounts",
        params: [["account"], {}],
      },
    } as unknown as RpcRequest;
    let responseSlot = 100;
    const transport = vi.fn(async () => ({
      result: { context: { slot: responseSlot }, value: [] },
    })) as unknown as RpcTransport;
    const rpc = withKaminoRpcTimeout(transport);
    await expect(withMinimumRpcSlot(101, () => rpc(accountRequest))).rejects.toThrow(/behind/);
    responseSlot = 101;
    await expect(withMinimumRpcSlot(101, () => rpc(accountRequest))).resolves.toHaveProperty(
      "result.context.slot",
      101
    );
    expect(transport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          params: [["account"], { commitment: "confirmed", minContextSlot: 101 }],
        }),
      })
    );
  });
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

interface SentRequest {
  payload: { method: string; params: unknown[] };
  signal: AbortSignal | undefined;
  resolve: (response: unknown) => void;
  reject: (reason: unknown) => void;
}

function fakeTransport() {
  const sent: SentRequest[] = [];
  const transport = (<TResponse>(config: RpcRequest) =>
    new Promise<TResponse>((resolve, reject) => {
      config.signal?.addEventListener("abort", () => reject(config.signal?.reason), {
        once: true,
      });
      sent.push({
        payload: config.payload as SentRequest["payload"],
        signal: config.signal,
        resolve: resolve as (response: unknown) => void,
        reject,
      });
    })) as RpcTransport;
  return { sent, transport };
}

let nextId = 0;
function read(method: string, params: unknown[], signal?: AbortSignal) {
  nextId += 1;
  return { payload: { id: String(nextId), jsonrpc: "2.0", method, params }, signal } as RpcRequest;
}

const ACCOUNTS = ["11111111111111111111111111111111"];
/** A later macrotask: past the one-microtask window kit's own coalescer covers. */
const laterTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const accountsResponse = (slot: bigint) => ({
  jsonrpc: "2.0",
  result: { context: { slot }, value: [null] },
});

describe("withKaminoReadDeduplication", () => {
  it("shares one in-flight response among identical requests", async () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);

    const first = shared(
      read("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed", encoding: "base64" }])
    );
    await laterTask();
    // Same params in a different key order: still the same request.
    const second = shared(
      read("getMultipleAccounts", [ACCOUNTS, { encoding: "base64", commitment: "confirmed" }])
    );
    expect(sent).toHaveLength(1);

    const response = accountsResponse(9n);
    sent[0]?.resolve(response);
    await expect(first).resolves.toBe(response);
    await expect(second).resolves.toBe(response);
  });

  it("never lets a caller join a request sent before its read floor", async () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);
    const params = [ACCOUNTS, { encoding: "base64" }];

    const before = shared(read("getMultipleAccounts", params));
    const rowsReadAt = readStamp();
    const floored = withReadFloor(rowsReadAt, () => shared(read("getMultipleAccounts", params)));
    // The fresh request replaces the stale entry: later callers share it.
    const unfloored = shared(read("getMultipleAccounts", params));
    const sameFloor = withReadFloor(rowsReadAt, () => shared(read("getMultipleAccounts", params)));
    expect(sent).toHaveLength(2);

    const stale = accountsResponse(1n);
    const fresh = accountsResponse(2n);
    sent[0]?.resolve(stale);
    sent[1]?.resolve(fresh);
    await expect(before).resolves.toBe(stale);
    await expect(floored).resolves.toBe(fresh);
    await expect(unfloored).resolves.toBe(fresh);
    await expect(sameFloor).resolves.toBe(fresh);
  });

  it("lets a caller join a request sent after its read floor", () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);
    const params = [ACCOUNTS, { encoding: "base64" }];

    const rowsReadAt = readStamp();
    void shared(read("getMultipleAccounts", params));
    void withReadFloor(rowsReadAt, () => shared(read("getMultipleAccounts", params)));

    expect(sent).toHaveLength(1);
  });

  it.each([
    ["getAccountInfo", [ACCOUNTS[0], { encoding: "base64" }]],
    ["getMultipleAccounts", [ACCOUNTS, { encoding: "base64" }]],
    ["getSlot", []],
    ["getTokenAccountsByOwner", [ACCOUNTS[0], { mint: ACCOUNTS[0] }, { encoding: "jsonParsed" }]],
  ])("shares %s", (method, params) => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);

    void shared(read(method, params));
    void shared(read(method, params));

    expect(sent).toHaveLength(1);
  });

  it.each([
    ["sendTransaction", ["AQID", { encoding: "base64" }]],
    ["simulateTransaction", ["AQID", { encoding: "base64" }]],
    ["getLatestBlockhash", [{ commitment: "confirmed" }]],
  ])("never shares %s", (method, params) => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);

    void shared(read(method, params));
    void shared(read(method, params));

    expect(sent.map((entry) => entry.payload.method)).toEqual([method, method]);
  });

  it("keeps requests apart when any param differs", () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);

    void shared(read("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed" }]));
    void shared(
      read("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed", minContextSlot: 7 }])
    );
    void shared(read("getAccountInfo", [ACCOUNTS[0], { commitment: "confirmed" }]));

    expect(sent).toHaveLength(3);
  });

  it("re-sends once the earlier request has settled, success or failure", async () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);

    const first = shared(read("getSlot", []));
    sent[0]?.resolve({ jsonrpc: "2.0", result: 1n });
    await first;
    const second = shared(read("getSlot", []));
    sent[1]?.reject(new Error("429 Too Many Requests"));
    await expect(second).rejects.toThrow("429");
    void shared(read("getSlot", []));

    expect(sent).toHaveLength(3);
  });

  it("rejects an abandoning consumer with its own reason and serves the rest", async () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);
    const leaving = new AbortController();
    const reason = new Error("caller gave up");

    const abandoned = shared(read("getMultipleAccounts", [ACCOUNTS], leaving.signal));
    const kept = shared(read("getMultipleAccounts", [ACCOUNTS], new AbortController().signal));
    leaving.abort(reason);

    await expect(abandoned).rejects.toBe(reason);
    expect(sent[0]?.signal?.aborted).toBe(false);
    const response = accountsResponse(3n);
    sent[0]?.resolve(response);
    await expect(kept).resolves.toBe(response);
  });

  it("aborts the shared request once every consumer has left", async () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoReadDeduplication(transport);
    const one = new AbortController();
    const two = new AbortController();

    const first = shared(read("getMultipleAccounts", [ACCOUNTS], one.signal));
    const second = shared(read("getMultipleAccounts", [ACCOUNTS], two.signal));
    one.abort(new Error("one"));
    two.abort(new Error("two"));
    await expect(first).rejects.toThrow("one");
    await expect(second).rejects.toThrow("two");

    expect(sent[0]?.signal?.aborted).toBe(true);
    // A later identical request starts afresh rather than joining the aborted one.
    void shared(read("getMultipleAccounts", [ACCOUNTS]));
    expect(sent).toHaveLength(2);
  });

  it("never shares a minimum-slot read with an unscoped read", async () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoRpcTimeout(withKaminoReadDeduplication(transport));
    const config = { commitment: "confirmed", encoding: "base64" };

    const scoped = withMinimumRpcSlot(100, () =>
      shared(read("getMultipleAccounts", [ACCOUNTS, config]))
    );
    const unscoped = shared(read("getMultipleAccounts", [ACCOUNTS, config]));
    await laterTask();

    expect(sent.map((entry) => entry.payload.params[1])).toEqual([
      { ...config, minContextSlot: 100 },
      config,
    ]);
    for (const entry of sent) entry.resolve(accountsResponse(150n));
    await expect(scoped).resolves.toBeDefined();
    await expect(unscoped).resolves.toBeDefined();
  });

  it("validates a shared response in every consumer's own scope", async () => {
    const { sent, transport } = fakeTransport();
    const shared = withKaminoRpcTimeout(withKaminoReadDeduplication(transport));
    const config = { commitment: "confirmed", encoding: "base64" };

    const met = withMinimumRpcSlot(100, () =>
      shared(read("getMultipleAccounts", [ACCOUNTS, config]))
    );
    const alsoMet = withMinimumRpcSlot(100, () =>
      shared(read("getMultipleAccounts", [ACCOUNTS, config]))
    );
    await laterTask();
    expect(sent).toHaveLength(1);
    sent[0]?.resolve(accountsResponse(100n));

    await expect(met).resolves.toHaveProperty("result.context.slot", 100n);
    await expect(alsoMet).resolves.toHaveProperty("result.context.slot", 100n);
  });
});

describe("createKaminoReadRpc", () => {
  it("shares one transport per endpoint across clients", async () => {
    const answered: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        answered.push(String(url));
        await gate;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: 42 }), {
          headers: { "content-type": "application/json" },
        });
      })
    );

    const first = createKaminoReadRpc("https://one.invalid").getSlot().send();
    await laterTask();
    const second = createKaminoReadRpc("https://one.invalid").getSlot().send();
    const other = createKaminoReadRpc("https://two.invalid").getSlot().send();
    await laterTask();
    release?.();

    await expect(Promise.all([first, second, other])).resolves.toEqual([42n, 42n, 42n]);
    expect(answered).toEqual(["https://one.invalid", "https://two.invalid"]);
  });
});

const socketDeath = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });

/** A fetch whose first request dies on its socket once `release` is called. */
function socketDyingFetch(result: (method: string) => unknown) {
  const bodies: Array<{ method: string; params: unknown[] }> = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: string; method: string; params: unknown[] };
      bodies.push(body);
      if (bodies.length === 1) {
        await gate;
        throw socketDeath();
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: result(body.method) }),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
  return { bodies, release: () => release() };
}

describe("socket retry", () => {
  it("re-sends a shared read once and answers every joiner", async () => {
    const { bodies, release } = socketDyingFetch(() => 42);
    const url = "https://socket-retry-shared.invalid";

    const first = createKaminoReadRpc(url).getSlot().send();
    await laterTask();
    const second = createKaminoReadRpc(url).getSlot().send();
    await laterTask();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([42n, 42n]);
    expect(bodies.map((body) => body.method)).toEqual(["getSlot", "getSlot"]);
  });

  it("keeps a scoped read's minimum slot on the re-send", async () => {
    const { bodies, release } = socketDyingFetch(() => ({ context: { slot: 150 }, value: [null] }));
    const read = withMinimumRpcSlot(100, () =>
      createKaminoReadRpc("https://socket-retry-scoped.invalid")
        .getMultipleAccounts([address(ACCOUNTS[0] ?? "")], { encoding: "base64" })
        .send()
    );
    await laterTask();
    release();

    await expect(read).resolves.toHaveProperty("context.slot", 150n);
    const scoped = { commitment: "confirmed", encoding: "base64", minContextSlot: 100 };
    expect(bodies.map((body) => body.params[1])).toEqual([scoped, scoped]);
  });

  it("re-sends a build-path read once", async () => {
    const { bodies, release } = socketDyingFetch(() => 7);
    const slot = createKaminoRpc("https://socket-retry-build.invalid").getSlot().send();
    await laterTask();
    release();

    await expect(slot).resolves.toBe(7n);
    expect(bodies).toHaveLength(2);
  });

  it("never re-sends a transaction", async () => {
    const { bodies, release } = socketDyingFetch(() => "signature");
    const sent = createKaminoRpc("https://socket-retry-send.invalid")
      .sendTransaction("AQID" as Base64EncodedWireTransaction, { encoding: "base64" })
      .send();
    await laterTask();
    release();

    await expect(sent).rejects.toThrow("fetch failed");
    expect(bodies.map((body) => body.method)).toEqual(["sendTransaction"]);
  });
});
