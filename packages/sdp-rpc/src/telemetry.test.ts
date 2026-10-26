import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types/well-known-tokens";
import { createDefaultRpcTransport } from "@solana/kit";
import { fetchWithReadSocketRetry, withReadSocketRetry } from "./socket-retry";
import {
  emitRpcTelemetry,
  pinRpcTelemetryEndpoint,
  type RpcTelemetryEvent,
  runWithPinnedRpcTelemetry,
  setRpcTelemetrySink,
} from "./telemetry";

const endpointUrl = "https://rpc.example.test/?api-key=private";
const envKey = "SOLANA_RPC_TRITON_DEVNET_API_KEY_URL";
const originalEndpoint = process.env[envKey];
const originalFetch = globalThis.fetch;

afterEach(() => {
  setRpcTelemetrySink(null);
  globalThis.fetch = originalFetch;
  if (originalEndpoint === undefined) delete process.env[envKey];
  else process.env[envKey] = originalEndpoint;
});

describe("RPC telemetry", () => {
  it("retains low-volume successes and every failure, then weights steady traffic", () => {
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));
    const attempt: RpcTelemetryEvent = {
      event: "sdp_rpc_attempt",
      surface: "managed_pool",
      provider: "triton",
      cluster: "devnet",
      method: "getSlot",
      outcome: "succeeded",
    };
    for (let index = 0; index < 30; index++) emitRpcTelemetry(attempt);
    emitRpcTelemetry({ ...attempt, outcome: "failed", status_code: 429 });
    emitRpcTelemetry({ ...attempt, provider: "helius" });

    assert.deepEqual(
      events
        .filter((event) => event.provider === "triton" && event.outcome === "succeeded")
        .map((event) => event.sample_weight),
      [...Array.from({ length: 10 }, () => 1), 10, 10]
    );
    assert.deepEqual(
      events
        .filter((event) => event.provider === "triton" && event.outcome === "failed")
        .map((event) => [event.status_code, event.sample_weight]),
      [[429, 1]]
    );
    assert.equal(events.at(-1)?.provider, "helius");
    assert.equal(events.at(-1)?.sample_weight, 1);
  });

  it("samples each RPC method even when methods repeat in a fixed order", () => {
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));
    for (let index = 0; index < 40; index++) {
      emitRpcTelemetry({
        event: "sdp_rpc_attempt",
        surface: "managed_pool",
        provider: "triton",
        cluster: "devnet",
        method: index % 2 === 0 ? "getSlot" : "getAccountInfo",
        outcome: "succeeded",
      });
    }

    for (const method of ["getSlot", "getAccountInfo"]) {
      assert.deepEqual(
        events.filter((event) => event.method === method).map((event) => event.sample_weight),
        [...Array.from({ length: 10 }, () => 1), 10]
      );
    }
  });

  it("counts physical pinned Kit proof attempts and transport errors without logging URLs", async () => {
    process.env[envKey] = endpointUrl;
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));
    const responses: unknown[] = [
      { jsonrpc: "2.0", result: "wrong-genesis" },
      { jsonrpc: "2.0", result: GENESIS_HASH_BY_CLUSTER.devnet },
    ];
    globalThis.fetch = async () => Response.json(responses.shift());
    const transport = createDefaultRpcTransport({ url: endpointUrl });
    const send = withReadSocketRetry(transport, endpointUrl);

    await runWithPinnedRpcTelemetry(async () => {
      pinRpcTelemetryEndpoint("devnet", endpointUrl);
      await send({ payload: { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] } });
      await send({ payload: { jsonrpc: "2.0", id: 2, method: "getGenesisHash", params: [] } });
    });

    assert.deepEqual(
      events.map((event) => [event.provider, event.outcome, event.sample_weight]),
      [
        ["triton", "failed", 1],
        ["triton", "succeeded", 1],
      ]
    );
    assert.ok(!JSON.stringify(events).includes("private"));
  });

  it("counts pinned fetch 429 failures and leaves unpinned fetches alone", async () => {
    process.env[envKey] = endpointUrl;
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });

    const init = {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
    };
    await fetchWithReadSocketRetry(endpointUrl, init);
    await runWithPinnedRpcTelemetry(async () => {
      pinRpcTelemetryEndpoint("devnet", endpointUrl);
      await fetchWithReadSocketRetry(endpointUrl, init);
    });

    assert.deepEqual(
      events.map((event) => [event.method, event.status_code, event.sample_weight]),
      [["getSlot", 429, 1]]
    );
  });

  it("classifies a 200 JSON-RPC error without consuming the caller's response", async () => {
    process.env[envKey] = endpointUrl;
    const body = { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } };
    globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
    let observed: (event: RpcTelemetryEvent) => void = () => undefined;
    const event = new Promise<RpcTelemetryEvent>((resolve) => {
      observed = resolve;
    });
    setRpcTelemetrySink(observed);

    const response = await runWithPinnedRpcTelemetry(async () => {
      pinRpcTelemetryEndpoint("devnet", endpointUrl);
      return fetchWithReadSocketRetry(endpointUrl, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
      });
    });

    assert.deepEqual(await response.json(), body);
    assert.deepEqual(
      (({ provider, method, outcome, status_code, sample_weight }) => ({
        provider,
        method,
        outcome,
        status_code,
        sample_weight,
      }))(await event),
      {
        provider: "triton",
        method: "getSlot",
        outcome: "failed",
        status_code: 200,
        sample_weight: 1,
      }
    );
  });

  it("marks a large HTTP 200 body unverified without buffering it for telemetry", async () => {
    process.env[envKey] = endpointUrl;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(65_536) });
    globalThis.fetch = async () =>
      new Response(body, { status: 200, headers: { "Content-Length": String(body.length) } });
    let observed: (event: RpcTelemetryEvent) => void = () => undefined;
    const event = new Promise<RpcTelemetryEvent>((resolve) => {
      observed = resolve;
    });
    setRpcTelemetrySink(observed);

    const response = await runWithPinnedRpcTelemetry(async () => {
      pinRpcTelemetryEndpoint("devnet", endpointUrl);
      return fetchWithReadSocketRetry(endpointUrl, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] }),
      });
    });

    assert.equal(await response.text(), body);
    assert.equal((await event).outcome, "http_success_unverified");
  });

  const responseCases = [
    { name: "null result", body: '{"result":null}', outcome: "succeeded" },
    { name: "result batch", body: '[{"result":1},{"result":2}]', outcome: "succeeded" },
    {
      name: "error in a mixed batch",
      body: '[7,{"error":{"code":-32005}}]',
      outcome: "failed",
    },
    {
      name: "malformed batch member",
      body: '[{"result":1},7]',
      outcome: "http_success_unverified",
    },
    { name: "empty batch", body: "[]", outcome: "http_success_unverified" },
    { name: "missing result", body: "{}", outcome: "http_success_unverified" },
    { name: "invalid JSON", body: "{broken", outcome: "http_success_unverified" },
  ] as const;

  for (const { name, body, outcome } of responseCases) {
    it(`classifies ${name} without changing the response body`, async () => {
      process.env[envKey] = endpointUrl;
      globalThis.fetch = async () => new Response(body);
      const observed = new Promise<RpcTelemetryEvent>((resolve) => setRpcTelemetrySink(resolve));

      const response = await runWithPinnedRpcTelemetry(async () => {
        pinRpcTelemetryEndpoint("devnet", endpointUrl);
        return fetchWithReadSocketRetry(endpointUrl, {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
        });
      });

      assert.equal(await response.text(), body);
      assert.equal((await observed).outcome, outcome);
    });
  }

  it("keeps concurrent Earn operations on their own pinned provider", async () => {
    const otherUrl = "https://rpc-other.example.test/?api-key=other-private";
    const otherKey = "SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL";
    const originalOther = process.env[otherKey];
    process.env[envKey] = endpointUrl;
    process.env[otherKey] = otherUrl;
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));
    globalThis.fetch = async () => Response.json({ jsonrpc: "2.0", id: 1, result: 7 });
    try {
      await Promise.all(
        ([endpointUrl, otherUrl] as const).map((url) =>
          runWithPinnedRpcTelemetry(async () => {
            pinRpcTelemetryEndpoint("devnet", url);
            await Promise.resolve();
            await withReadSocketRetry(
              createDefaultRpcTransport({ url }),
              url
            )({
              payload: { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] },
            });
          })
        )
      );
    } finally {
      if (originalOther === undefined) delete process.env[otherKey];
      else process.env[otherKey] = originalOther;
    }
    assert.deepEqual(events.map((event) => event.provider).sort(), ["helius", "triton"]);
    assert.ok(!JSON.stringify(events).includes("private"));
  });
});
