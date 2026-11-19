import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSafeProxyOperation, SAFE_PROXY_MAX_BUDGET_MS, safeProxyCatalog } from "./catalog";
import { createSafeProxyClient, type SafeProxyTransport } from "./client";
import { SAFE_PROXY_CALLER_GRACE_MS, safeProxyRequestEnvelopeSchema } from "./envelope";
import { SafeProxyError, type SafeProxyErrorCode, type SafeProxyOutcome } from "./errors";

type TransportCall = Parameters<SafeProxyTransport>[0];

function clientAnswering(answer: () => Promise<Awaited<ReturnType<SafeProxyTransport>>>) {
  const calls: TransportCall[] = [];
  const transport: SafeProxyTransport = async (call) => {
    calls.push(call);
    return answer();
  };
  return { calls, client: createSafeProxyClient({ transport, requestId: () => "req_test" }) };
}

function clientReturning(status: number, body: unknown) {
  return clientAnswering(async () => ({ status, body })).client;
}

async function assertFailsWith(
  promise: Promise<unknown>,
  code: SafeProxyErrorCode,
  outcome: SafeProxyOutcome
): Promise<SafeProxyError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof SafeProxyError);
  assert.equal(caught.code, code);
  assert.equal(caught.outcome, outcome);
  return caught;
}

describe("createSafeProxyClient", () => {
  it("sends the operation's path, envelope and timeout", async () => {
    const { calls, client } = clientAnswering(async () => ({
      status: 200,
      body: { ok: true, output: { service: "safe-proxy" } },
    }));
    await client.system.ping({ input: {} });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    const budgetMs = safeProxyCatalog.system.ping.budgetMs;
    assert.equal(call.path, "/v1/call/system/ping");
    assert.equal(call.envelope.requestId, "req_test");
    assert.equal(call.envelope.budgetMs, budgetMs);
    assert.deepEqual(call.envelope.input, {});
    assert.equal(call.timeoutMs, budgetMs + SAFE_PROXY_CALLER_GRACE_MS);
    const schema = safeProxyRequestEnvelopeSchema(safeProxyCatalog.system.ping);
    assert.equal(schema.safeParse(call.envelope).success, true);
  });

  it("returns only the declared output fields", async () => {
    const client = clientReturning(200, {
      ok: true,
      output: { service: "safe-proxy", undeclared: "x" },
    });
    assert.deepEqual(await client.system.ping({ input: {} }), { service: "safe-proxy" });
  });

  it("throws the code and outcome the service answered with", async () => {
    const client = clientReturning(502, {
      ok: false,
      error: { code: "provider_unavailable", outcome: "no_answer" },
    });
    await assertFailsWith(client.system.ping({ input: {} }), "provider_unavailable", "no_answer");
  });

  it("reports proxy_unreachable / no_answer with the cause when the transport throws", async () => {
    const thrown = new Error("socket closed");
    const { client } = clientAnswering(async () => {
      throw thrown;
    });
    const error = await assertFailsWith(
      client.system.ping({ input: {} }),
      "proxy_unreachable",
      "no_answer"
    );
    assert.equal(error.cause, thrown);
  });

  it("reports caller_not_allowed / rejected for a non-envelope 401 or 403", async () => {
    for (const status of [401, 403]) {
      const client = clientReturning(status, "Forbidden");
      await assertFailsWith(client.system.ping({ input: {} }), "caller_not_allowed", "rejected");
    }
  });

  it("reports proxy_unreachable / no_answer for a non-envelope body at any other status", async () => {
    for (const [status, body] of [
      [200, "<html>"],
      [500, {}],
      [503, null],
    ] as const) {
      const client = clientReturning(status, body);
      await assertFailsWith(client.system.ping({ input: {} }), "proxy_unreachable", "no_answer");
    }
  });

  it("reports proxy_unreachable / no_answer when the output fails the response schema", async () => {
    const client = clientReturning(200, { ok: true, output: { service: "other" } });
    await assertFailsWith(client.system.ping({ input: {} }), "proxy_unreachable", "no_answer");
  });
});

describe("safeProxyCatalog", () => {
  it("declares callers, a bounded budget, and a paired read for every change", () => {
    for (const [section, operations] of Object.entries(safeProxyCatalog)) {
      for (const name of Object.keys(operations)) {
        const operation = findSafeProxyOperation(section, name);
        assert.ok(operation, `${section}.${name}`);
        assert.ok(operation.callers.length > 0, `${section}.${name} callers`);
        assert.ok(Number.isInteger(operation.budgetMs), `${section}.${name} budget`);
        assert.ok(operation.budgetMs >= 1 && operation.budgetMs <= SAFE_PROXY_MAX_BUDGET_MS);
        if (operation.kind === "changes") {
          const [pairedSection, pairedName] = operation.pairedRead.split(".");
          assert.ok(pairedSection !== undefined && pairedName !== undefined);
          const paired = findSafeProxyOperation(pairedSection, pairedName);
          assert.ok(paired, operation.pairedRead);
          assert.equal(paired.kind, "reads");
        }
      }
    }
  });
});

describe("findSafeProxyOperation", () => {
  it("finds a declared operation", () => {
    assert.equal(findSafeProxyOperation("system", "ping"), safeProxyCatalog.system.ping);
  });

  it("returns undefined for unknown and inherited names", () => {
    assert.equal(findSafeProxyOperation("unknown", "ping"), undefined);
    assert.equal(findSafeProxyOperation("system", "unknown"), undefined);
    for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.equal(findSafeProxyOperation(inherited, "ping"), undefined, `section ${inherited}`);
      assert.equal(findSafeProxyOperation("system", inherited), undefined, `name ${inherited}`);
    }
  });
});
