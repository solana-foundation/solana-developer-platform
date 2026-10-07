import { readStamp, withMinimumRpcSlot, withReadFloor } from "@sdp/rpc/read-context";
import { address, type Base64EncodedWireTransaction, type RpcTransport } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVedaReadRpc,
  createVedaRpc,
  VEDA_BLOCK_TIME_TTL_MS,
  VEDA_SHARED_READ_JOIN_WINDOW_MS,
  withVedaReadDeduplication,
  withVedaRpcTimeout,
} from "./rpc";

/**
 * The position-read transport's de-duplication, against a fake transport that
 * records every request it is asked to send and settles only when told to, and
 * both clients' dead-socket re-send, against a stubbed `fetch`.
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
  vi.unstubAllGlobals();
});

describe("withVedaReadDeduplication", () => {
  it("shares each read a position read sends", async () => {
    for (const [method, params] of [
      ["getAccountInfo", [ACCOUNTS[0], { encoding: "base64" }]],
      ["getBlockTime", [5]],
      ["getMultipleAccounts", [ACCOUNTS, { encoding: "base64" }]],
      ["getProgramAccounts", [ACCOUNTS[0], { encoding: "base64" }]],
    ] as const) {
      const { sent, transport } = fakeTransport();
      const read = withVedaReadDeduplication(transport);
      void read(request(method, [...params]));
      await laterTask();
      void read(request(method, [...params]));
      expect(sent, method).toHaveLength(1);
    }
  });

  it("never shares or remembers a send, a simulation or a blockhash", async () => {
    for (const [method, params] of [
      ["sendTransaction", ["AQ==", { encoding: "base64" }]],
      ["simulateTransaction", ["AQ==", { encoding: "base64", sigVerify: false }]],
      ["getLatestBlockhash", [{ commitment: "confirmed" }]],
    ] as const) {
      const { sent, transport } = fakeTransport();
      const read = withVedaReadDeduplication(transport);
      const first = read(request(method, [...params]));
      await laterTask();
      const second = read(request(method, [...params]));
      expect(sent, method).toHaveLength(2);

      sent[0]?.resolve({ jsonrpc: "2.0", result: "first" });
      sent[1]?.resolve({ jsonrpc: "2.0", result: "second" });
      await expect(first).resolves.toEqual({ jsonrpc: "2.0", result: "first" });
      await expect(second).resolves.toEqual({ jsonrpc: "2.0", result: "second" });
      void read(request(method, [...params]));
      expect(sent, method).toHaveLength(3);
    }
  });

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

  it("never lets a caller join a request sent before its read floor", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);
    const params = [ACCOUNTS, { encoding: "base64" }];

    const before = read(request("getMultipleAccounts", params));
    const rowsReadAt = readStamp();
    const floored = withReadFloor(rowsReadAt, () => read(request("getMultipleAccounts", params)));
    // The fresh request replaces the stale entry: later callers share it.
    const unfloored = read(request("getMultipleAccounts", params));
    expect(sent).toHaveLength(2);

    const stale = { jsonrpc: "2.0", result: { context: { slot: 1n }, value: [null] } };
    const fresh = { jsonrpc: "2.0", result: { context: { slot: 2n }, value: [null] } };
    sent[0]?.resolve(stale);
    sent[1]?.resolve(fresh);
    await expect(before).resolves.toBe(stale);
    await expect(floored).resolves.toBe(fresh);
    await expect(unfloored).resolves.toBe(fresh);
  });

  it("lets a caller join a request sent after its read floor", () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);
    const params = [ACCOUNTS, { encoding: "base64" }];

    const rowsReadAt = readStamp();
    void read(request("getMultipleAccounts", params));
    void withReadFloor(rowsReadAt, () => read(request("getMultipleAccounts", params)));

    expect(sent).toHaveLength(1);
  });

  it("never lets a caller join a request sent a join window or more ago", async () => {
    const { sent, transport } = fakeTransport();
    const read = withVedaReadDeduplication(transport);
    const params = [ACCOUNTS, { encoding: "base64" }];
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);

    const stalled = read(request("getMultipleAccounts", params));
    clock.mockReturnValue(10_000 + VEDA_SHARED_READ_JOIN_WINDOW_MS - 1);
    const joined = read(request("getMultipleAccounts", params));
    expect(sent).toHaveLength(1);
    clock.mockReturnValue(10_000 + VEDA_SHARED_READ_JOIN_WINDOW_MS);
    const later = read(request("getMultipleAccounts", params));
    expect(sent).toHaveLength(2);

    const fresh = { jsonrpc: "2.0", result: { context: { slot: 2n }, value: [null] } };
    sent[1]?.resolve(fresh);
    await expect(later).resolves.toBe(fresh);
    const old = { jsonrpc: "2.0", result: { context: { slot: 1n }, value: [null] } };
    sent[0]?.resolve(old);
    await expect(stalled).resolves.toBe(old);
    await expect(joined).resolves.toBe(old);
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

const socketDeath = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A `fetch` that plays `script` in order: "die" rejects at once, as a pooled
 * socket the server already closed does, "die-later" rejects the same way once
 * released, and "answer" answers once released. A send past the script fails.
 */
function scriptedWire(script: readonly ("die" | "die-later" | "answer")[]) {
  const bodies: unknown[] = [];
  const held: (() => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const payload = record(JSON.parse(String(init?.body)));
      bodies.push(payload);
      const step = script[bodies.length - 1];
      if (step === undefined) throw new Error("unscripted send");
      if (step === "die") throw socketDeath();
      await new Promise<void>((resolve) => held.push(resolve));
      if (step === "die-later") throw socketDeath();
      const value = payload?.method === "getMultipleAccounts" ? [null] : null;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload?.id,
          result: { context: { slot: 150 }, value },
        }),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
  return {
    bodies,
    release() {
      for (const settle of held.splice(0)) settle();
    },
  };
}

const ACCOUNT = address("11111111111111111111111111111111");

describe("a pooled socket that dies before the response", () => {
  it("re-sends a shared read once and answers every consumer from it", async () => {
    const wire = scriptedWire(["die", "answer"]);
    const rpc = createVedaReadRpc("https://veda-socket-shared.invalid");

    const first = rpc.getMultipleAccounts([ACCOUNT], { encoding: "base64" }).send();
    await laterTask();
    const second = rpc.getMultipleAccounts([ACCOUNT], { encoding: "base64" }).send();
    await laterTask();
    wire.release();

    const answer = { context: { slot: 150n }, value: [null] };
    await expect(Promise.all([first, second])).resolves.toEqual([answer, answer]);
    expect(wire.bodies).toHaveLength(2);
    expect(wire.bodies[1]).toEqual(wire.bodies[0]);
  });

  it("re-sends once in all, not once per consumer, when the re-send dies too", async () => {
    const wire = scriptedWire(["die", "die-later"]);
    const rpc = createVedaReadRpc("https://veda-socket-twice.invalid");

    const first = rpc.getMultipleAccounts([ACCOUNT], { encoding: "base64" }).send();
    await laterTask();
    const second = rpc.getMultipleAccounts([ACCOUNT], { encoding: "base64" }).send();
    await laterTask();
    wire.release();

    await expect(first).rejects.toThrow("fetch failed");
    await expect(second).rejects.toThrow("fetch failed");
    expect(wire.bodies).toHaveLength(2);
  });

  it("re-sends a minimum-slot read with its scope intact", async () => {
    const wire = scriptedWire(["die", "answer"]);
    const rpc = createVedaReadRpc("https://veda-socket-scoped.invalid");

    const read = withMinimumRpcSlot(100, () =>
      rpc.getMultipleAccounts([ACCOUNT], { encoding: "base64" }).send()
    );
    await laterTask();
    wire.release();

    await expect(read).resolves.toEqual({ context: { slot: 150n }, value: [null] });
    const scoped = { commitment: "confirmed", encoding: "base64", minContextSlot: 100 };
    expect(wire.bodies.map((body) => record(body)?.params)).toEqual([
      [[ACCOUNT], scoped],
      [[ACCOUNT], scoped],
    ]);
  });

  it("re-sends a read on the build client, never a transaction", async () => {
    const wire = scriptedWire(["die", "answer", "die"]);
    const rpc = createVedaRpc("https://veda-socket-build.invalid");

    const read = rpc.getAccountInfo(ACCOUNT, { encoding: "base64" }).send();
    await laterTask();
    wire.release();
    await expect(read).resolves.toEqual({ context: { slot: 150n }, value: null });

    await expect(
      rpc.sendTransaction("AQ==" as Base64EncodedWireTransaction, { encoding: "base64" }).send()
    ).rejects.toThrow("fetch failed");
    expect(wire.bodies.map((body) => record(body)?.method)).toEqual([
      "getAccountInfo",
      "getAccountInfo",
      "sendTransaction",
    ]);
  });
});
