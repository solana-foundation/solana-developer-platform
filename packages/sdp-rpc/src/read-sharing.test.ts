import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDefaultRpcTransport, type RpcTransport } from "@solana/kit";
import { readStamp, withMinimumRpcSlot, withReadFloor, withRpcReadContext } from "./read-context";
import {
  SHARED_BLOCK_TIME_TTL_MS,
  SHARED_READ_JOIN_WINDOW_MS,
  withInFlightReadSharing,
} from "./read-sharing";

type JsonRpcBody = { result: unknown } | { error: { code: number; message: string } };

type HeldRequest = {
  method: string;
  params: unknown;
  signal: AbortSignal;
  answer: (body: JsonRpcBody) => void;
};

type RpcRequest = Parameters<RpcTransport>[0];

const ENDPOINT_URL = "https://read-sharing.example.test";
const ACCOUNTS = ["11111111111111111111111111111111"];
const BLOCK_NOT_AVAILABLE = { error: { code: -32004, message: "Block not available" } };

const originalFetch = globalThis.fetch;

let nextRequestId = 0;

function holdRequests(): HeldRequest[] {
  const held: HeldRequest[] = [];
  globalThis.fetch = (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      assert.ok(init !== undefined && typeof init.body === "string");
      const { signal } = init;
      assert.ok(signal instanceof AbortSignal);
      const payload: unknown = JSON.parse(init.body);
      assert.ok(
        typeof payload === "object" &&
          payload !== null &&
          "id" in payload &&
          "method" in payload &&
          typeof payload.method === "string" &&
          "params" in payload
      );
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      held.push({
        method: payload.method,
        params: payload.params,
        signal,
        answer: (body) =>
          resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, ...body }))),
      });
    });
  return held;
}

function read(method: string, params: readonly unknown[]): RpcRequest {
  nextRequestId += 1;
  return { payload: { jsonrpc: "2.0", id: nextRequestId, method, params } };
}

function sharingTransport(): RpcTransport {
  return withInFlightReadSharing(createDefaultRpcTransport({ url: ENDPOINT_URL }));
}

function accounts(slot: number): JsonRpcBody {
  return { result: { context: { slot }, value: [null] } };
}

function resultOf(response: unknown): unknown {
  assert.ok(typeof response === "object" && response !== null && "result" in response);
  return response.result;
}

describe("withInFlightReadSharing", () => {
  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  });

  it("shares one in-flight response among identical requests, whatever their key order", async () => {
    const held = holdRequests();
    const shared = sharingTransport();

    const first = shared(
      read("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed", encoding: "base64" }])
    );
    await nextTurn();
    const second = shared(
      read("getMultipleAccounts", [ACCOUNTS, { encoding: "base64", commitment: "confirmed" }])
    );
    await nextTurn();
    assert.equal(held.length, 1);

    held[0].answer(accounts(9));
    assert.equal(await first, await second);
  });

  for (const [method, params] of [
    ["getAccountInfo", [ACCOUNTS[0], { encoding: "base64" }]],
    ["getBlockTime", [5]],
    ["getMultipleAccounts", [ACCOUNTS, { encoding: "base64" }]],
    ["getProgramAccounts", [ACCOUNTS[0], { encoding: "base64" }]],
    ["getSlot", []],
    ["getTokenAccountsByOwner", [ACCOUNTS[0], { mint: ACCOUNTS[0] }, { encoding: "jsonParsed" }]],
  ] as const) {
    it(`shares ${method}`, async () => {
      const held = holdRequests();
      const shared = sharingTransport();

      void shared(read(method, params));
      await nextTurn();
      void shared(read(method, params));
      await nextTurn();

      assert.equal(held.length, 1);
    });
  }

  for (const [method, params] of [
    ["sendTransaction", ["AQ==", { encoding: "base64" }]],
    ["simulateTransaction", ["AQ==", { encoding: "base64", sigVerify: false }]],
    ["getLatestBlockhash", [{ commitment: "confirmed" }]],
  ] as const) {
    it(`never shares or remembers ${method}`, async () => {
      const held = holdRequests();
      const shared = sharingTransport();

      const first = shared(read(method, params));
      await nextTurn();
      const second = shared(read(method, params));
      await nextTurn();
      assert.equal(held.length, 2);

      held[0].answer({ result: "first" });
      held[1].answer({ result: "second" });
      assert.equal(resultOf(await first), "first");
      assert.equal(resultOf(await second), "second");
      void shared(read(method, params));
      await nextTurn();
      assert.equal(held.length, 3);
    });
  }

  it("never lets a caller join a request sent before its read floor", async () => {
    const held = holdRequests();
    const shared = sharingTransport();
    const params = [ACCOUNTS, { encoding: "base64" }];

    const before = shared(read("getMultipleAccounts", params));
    await nextTurn();
    const rowsReadAt = readStamp();
    const floored = withReadFloor(rowsReadAt, () => shared(read("getMultipleAccounts", params)));
    await nextTurn();
    const unfloored = shared(read("getMultipleAccounts", params));
    const sameFloor = withReadFloor(rowsReadAt, () => shared(read("getMultipleAccounts", params)));
    await nextTurn();
    assert.equal(held.length, 2);

    held[0].answer(accounts(1));
    held[1].answer(accounts(2));
    const [beforeResponse, flooredResponse, unflooredResponse, sameFloorResponse] =
      await Promise.all([before, floored, unfloored, sameFloor]);
    assert.notEqual(beforeResponse, flooredResponse);
    assert.equal(unflooredResponse, flooredResponse);
    assert.equal(sameFloorResponse, flooredResponse);
  });

  it("lets a caller join a request sent after its read floor", async () => {
    const held = holdRequests();
    const shared = sharingTransport();
    const params = [ACCOUNTS, { encoding: "base64" }];

    const rowsReadAt = readStamp();
    void shared(read("getMultipleAccounts", params));
    await nextTurn();
    void withReadFloor(rowsReadAt, () => shared(read("getMultipleAccounts", params)));
    await nextTurn();

    assert.equal(held.length, 1);
  });

  it("never lets a caller join a read sent a join window or more ago", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const held = holdRequests();
    const shared = sharingTransport();
    const params = [ACCOUNTS, { encoding: "base64" }];

    const stalled = shared(read("getMultipleAccounts", params));
    await nextTurn();
    mock.timers.tick(SHARED_READ_JOIN_WINDOW_MS - 1);
    const joined = shared(read("getMultipleAccounts", params));
    await nextTurn();
    assert.equal(held.length, 1);
    mock.timers.tick(1);
    const later = shared(read("getMultipleAccounts", params));
    await nextTurn();
    assert.equal(held.length, 2);
    const alsoLater = shared(read("getMultipleAccounts", params));
    await nextTurn();
    assert.equal(held.length, 2);

    held[1].answer(accounts(2));
    held[0].answer(accounts(1));
    const [stalledResponse, joinedResponse, laterResponse, alsoLaterResponse] = await Promise.all([
      stalled,
      joined,
      later,
      alsoLater,
    ]);
    assert.equal(joinedResponse, stalledResponse);
    assert.equal(alsoLaterResponse, laterResponse);
    assert.notEqual(laterResponse, stalledResponse);
  });

  it("keeps requests apart when any param differs", async () => {
    const held = holdRequests();
    const shared = sharingTransport();

    void shared(read("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed" }]));
    void shared(
      read("getMultipleAccounts", [ACCOUNTS, { commitment: "confirmed", minContextSlot: 7 }])
    );
    void shared(read("getAccountInfo", [ACCOUNTS[0], { commitment: "confirmed" }]));
    await nextTurn();

    assert.equal(held.length, 3);
  });

  it("re-sends once the earlier request has settled, success or error", async () => {
    const held = holdRequests();
    const shared = sharingTransport();

    const first = shared(read("getSlot", []));
    await nextTurn();
    held[0].answer({ result: 1 });
    await first;
    const second = shared(read("getSlot", []));
    await nextTurn();
    held[1].answer({ error: { code: -32005, message: "Node is behind" } });
    await second;
    void shared(read("getSlot", []));
    await nextTurn();

    assert.equal(held.length, 3);
  });

  it("remembers a slot's block time, never an error or a null", async () => {
    const held = holdRequests();
    const shared = sharingTransport();

    const known = shared(read("getBlockTime", [5]));
    await nextTurn();
    held[0].answer({ result: 1_800_000_000 });
    const knownResponse = await known;
    assert.equal(await shared(read("getBlockTime", [5])), knownResponse);
    assert.equal(held.length, 1);

    const missing = shared(read("getBlockTime", [6]));
    await nextTurn();
    held[1].answer({ result: null });
    await missing;
    const failed = shared(read("getBlockTime", [7]));
    await nextTurn();
    held[2].answer(BLOCK_NOT_AVAILABLE);
    await failed;
    void shared(read("getBlockTime", [6]));
    void shared(read("getBlockTime", [7]));
    await nextTurn();

    assert.deepEqual(
      held.map((request) => request.params),
      [[5], [6], [7], [6], [7]]
    );
  });

  it("forgets a block time once its window ends", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const held = holdRequests();
    const shared = sharingTransport();

    const known = shared(read("getBlockTime", [5]));
    await nextTurn();
    held[0].answer({ result: 1_800_000_000 });
    await known;
    mock.timers.tick(SHARED_BLOCK_TIME_TTL_MS - 1);
    void shared(read("getBlockTime", [5]));
    await nextTurn();
    assert.equal(held.length, 1);
    mock.timers.tick(1);
    void shared(read("getBlockTime", [5]));
    await nextTurn();

    assert.equal(held.length, 2);
  });

  it("rejects an abandoning consumer with its own reason and serves the rest", async () => {
    const held = holdRequests();
    const shared = sharingTransport();
    const leaving = new AbortController();
    const reason = new Error("caller gave up");

    const abandoned = shared({
      ...read("getMultipleAccounts", [ACCOUNTS]),
      signal: leaving.signal,
    });
    const kept = shared({
      ...read("getMultipleAccounts", [ACCOUNTS]),
      signal: new AbortController().signal,
    });
    await nextTurn();
    leaving.abort(reason);

    await assert.rejects(abandoned, (error: unknown) => error === reason);
    await nextTurn();
    assert.equal(held[0].signal.aborted, false);
    held[0].answer(accounts(3));
    assert.deepEqual(resultOf(await kept), { context: { slot: 3n }, value: [null] });
    assert.equal(held.length, 1);
  });

  it("aborts the shared request once every consumer has left, and starts the next one afresh", async () => {
    const held = holdRequests();
    const shared = sharingTransport();
    const one = new AbortController();
    const two = new AbortController();
    const oneReason = new Error("one");
    const twoReason = new Error("two");

    const first = shared({ ...read("getMultipleAccounts", [ACCOUNTS]), signal: one.signal });
    const second = shared({ ...read("getMultipleAccounts", [ACCOUNTS]), signal: two.signal });
    await nextTurn();
    one.abort(oneReason);
    two.abort(twoReason);
    await assert.rejects(first, (error: unknown) => error === oneReason);
    await assert.rejects(second, (error: unknown) => error === twoReason);
    await nextTurn();

    assert.equal(held[0].signal.aborted, true);
    void shared(read("getMultipleAccounts", [ACCOUNTS]));
    await nextTurn();
    assert.equal(held.length, 2);
  });

  it("never shares a minimum-slot read with an unscoped read below the read context", async () => {
    const held = holdRequests();
    const scoped = withRpcReadContext(sharingTransport());
    const config = { commitment: "confirmed", encoding: "base64" };

    const minimumSlotRead = withMinimumRpcSlot(100, () =>
      scoped(read("getMultipleAccounts", [ACCOUNTS, config]))
    );
    await nextTurn();
    const unscopedRead = scoped(read("getMultipleAccounts", [ACCOUNTS, config]));
    await nextTurn();

    assert.deepEqual(
      held.map((request) => request.params),
      [
        [ACCOUNTS, { ...config, minContextSlot: 100 }],
        [ACCOUNTS, config],
      ]
    );
    for (const request of held) request.answer(accounts(150));
    await minimumSlotRead;
    await unscopedRead;
  });

  it("validates one shared response in every joiner's own minimum-slot scope", async () => {
    const held = holdRequests();
    const scoped = withRpcReadContext(sharingTransport());
    const config = { commitment: "confirmed", encoding: "base64" };

    const met = withMinimumRpcSlot(100, () =>
      scoped(read("getMultipleAccounts", [ACCOUNTS, config]))
    );
    await nextTurn();
    const alsoMet = withMinimumRpcSlot(100, () =>
      scoped(read("getMultipleAccounts", [ACCOUNTS, config]))
    );
    await nextTurn();
    assert.equal(held.length, 1);

    held[0].answer(accounts(100));
    assert.equal(await met, await alsoMet);
  });
});
