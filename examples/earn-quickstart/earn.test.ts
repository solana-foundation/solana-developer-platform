import assert from "node:assert/strict";
import test from "node:test";
import { type DepositOptions, deposit, type Operation } from "./earn.ts";

const prepared: Operation = {
  id: "op/one",
  status: "prepared",
  actionId: "opa_one",
  version: 1,
  terms: { fees: null },
  nextAction: { type: "sign_transaction", transaction: "unsigned" },
};

/** Answers each path from a queue of operations and records every request. */
function fakeApi(responses: Record<string, Array<Partial<Operation>>>) {
  const requests: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
  const send: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      method: init?.method ?? "GET",
      path,
      headers: new Headers(init?.headers),
      body,
    });
    const next = responses[path]?.shift();
    if (next === undefined) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    return Response.json({ data: { operation: { ...prepared, ...next } } }, { status: 202 });
  };
  return { requests, send };
}

function options(send: typeof fetch, sign: DepositOptions["sign"]): DepositOptions {
  return {
    apiUrl: "https://api.example.invalid",
    apiKey: "server-key",
    deposit: {
      strategyId: "earn_strategy_one",
      source: { ownerAddress: "owner" },
      amount: { mint: "usdc", value: "10" },
    },
    idempotencyKey: "saved-key",
    sign,
    fetch: send,
    pollIntervalMs: 0,
  };
}

test("prepares, signs the exact transaction, submits and polls to completion", async () => {
  const api = fakeApi({
    "/v1/earn/deposit": [{}],
    "/v1/operations/op%2Fone/submit": [{ status: "queued", nextAction: null }],
    "/v1/operations/op%2Fone": [{ status: "submitted" }, { status: "completed", nextAction: null }],
  });
  const signed: string[] = [];
  const result = await deposit(
    options(api.send, async (transaction, operation) => {
      assert.equal(operation.actionId, "opa_one");
      signed.push(transaction);
      return "signed-bytes";
    })
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(signed, ["unsigned"]);
  assert.deepEqual(
    api.requests.map(({ method, path }) => `${method} ${path}`),
    [
      "POST /v1/earn/deposit",
      "POST /v1/operations/op%2Fone/submit",
      "GET /v1/operations/op%2Fone",
      "GET /v1/operations/op%2Fone",
    ]
  );
  const [prepare, submit, poll] = api.requests;
  assert.equal(prepare?.headers.get("Authorization"), "Bearer server-key");
  assert.equal(prepare?.headers.get("Idempotency-Key"), "saved-key:prepare");
  assert.deepEqual(prepare?.body, options(api.send, async () => "").deposit);
  assert.equal(submit?.headers.get("Idempotency-Key"), "saved-key:submit");
  assert.deepEqual(submit?.body, {
    actionId: "opa_one",
    version: 1,
    signedTransaction: "signed-bytes",
  });
  assert.equal(poll?.headers.get("Idempotency-Key"), null);
});

test("a replayed, already submitted preparation polls without signing again", async () => {
  const api = fakeApi({
    "/v1/earn/deposit": [{ status: "queued", nextAction: null }],
    "/v1/operations/op%2Fone": [{ status: "completed", nextAction: null }],
  });
  const result = await deposit(
    options(api.send, async () => assert.fail("must not sign a submitted operation"))
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(
    api.requests.map(({ method, path }) => `${method} ${path}`),
    ["POST /v1/earn/deposit", "GET /v1/operations/op%2Fone"]
  );
});

test("an API error stops the flow and reports the response", async () => {
  const api = fakeApi({});
  await assert.rejects(
    deposit(options(api.send, async () => "signed-bytes")),
    /SDP 404 on \/v1\/earn\/deposit: .*NOT_FOUND/
  );
  assert.equal(api.requests.length, 1);
});
