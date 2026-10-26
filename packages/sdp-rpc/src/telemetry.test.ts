import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types/well-known-tokens";
import type { RpcTransport } from "@solana/kit";
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

  it("counts physical pinned Kit proof attempts and transport errors without logging URLs", async () => {
    process.env[envKey] = endpointUrl;
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));
    const responses: unknown[] = [
      { jsonrpc: "2.0", result: "wrong-genesis" },
      { jsonrpc: "2.0", result: GENESIS_HASH_BY_CLUSTER.devnet },
    ];
    const transport: RpcTransport = async <TResponse>() => responses.shift() as TResponse;
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

  it("keeps concurrent Earn operations on their own pinned provider", async () => {
    const otherUrl = "https://rpc-other.example.test/?api-key=other-private";
    const otherKey = "SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL";
    const originalOther = process.env[otherKey];
    process.env[envKey] = endpointUrl;
    process.env[otherKey] = otherUrl;
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));
    const transport: RpcTransport = async <TResponse>() =>
      ({ jsonrpc: "2.0", result: 7 }) as TResponse;
    try {
      await Promise.all(
        ([endpointUrl, otherUrl] as const).map((url) =>
          runWithPinnedRpcTelemetry(async () => {
            pinRpcTelemetryEndpoint("devnet", url);
            await Promise.resolve();
            await withReadSocketRetry(
              transport,
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
