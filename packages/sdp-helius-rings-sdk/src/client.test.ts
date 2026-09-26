import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { createRingsClient } from "./client.js";
import { TEST_OWNER } from "./test/shielded-identity-fixtures.js";

const RPC_URL = "https://rpc.example.test/rpc?api-key=secret";

function jsonRpcResponse(id: string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
}

function stubFetch(handler: (url: string, body: string) => Response): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = input.toString();
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body });
      return handler(url, body);
    },
  };
}

describe("createRingsClient Solana RPC transport", () => {
  it("carries the Solana RPC leg through the supplied fetch", async () => {
    const { fetch, calls } = stubFetch((_url, body) => {
      const method = (JSON.parse(body) as { method: string }).method;
      if (method === "getBalance") {
        // Raw wire JSON carrying a u64 no Number can hold: the bigint codec
        // must keep it exact where a plain JSON.parse would round it.
        return new Response(
          '{"jsonrpc":"2.0","id":"1","result":{"context":{"slot":1},"value":12345678901234567890}}',
          { status: 200 }
        );
      }
      return jsonRpcResponse("1", { context: { slot: 1 }, value: null });
    });

    const client = await createRingsClient({
      solanaRpcUrl: RPC_URL,
      indexerUrl: "https://indexer.example.test",
      proverUrl: "https://prover.example.test",
      fetch,
    });

    const balance = await client.getBalance(address(TEST_OWNER));
    expect(balance).toBe(12345678901234567890n);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(RPC_URL);
  });

  it("never dials the process-global fetch on the Solana leg", async () => {
    const { fetch } = stubFetch(() => jsonRpcResponse("1", { context: { slot: 1 }, value: null }));
    const globalFetch = vi.spyOn(globalThis, "fetch");

    const client = await createRingsClient({
      solanaRpcUrl: RPC_URL,
      indexerUrl: "https://indexer.example.test",
      proverUrl: "https://prover.example.test",
      fetch,
    });

    await expect(client.getAccount(address(TEST_OWNER))).resolves.toBeUndefined();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("refuses to follow a redirect instead of riding it to a second endpoint", async () => {
    const { fetch, calls } = stubFetch(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.example.test/rpc" },
        })
    );

    const client = await createRingsClient({
      solanaRpcUrl: RPC_URL,
      indexerUrl: "https://indexer.example.test",
      proverUrl: "https://prover.example.test",
      fetch,
    });

    await expect(client.getAccount(address(TEST_OWNER))).rejects.toMatchObject({
      code: "CLIENT_RPC",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(RPC_URL);
  });

  it("propagates a guard refusal instead of falling back to another transport", async () => {
    const { fetch, calls } = stubFetch(() => {
      throw Object.assign(new Error("refused"), { name: "EgressBlockedError" });
    });

    const client = await createRingsClient({
      solanaRpcUrl: RPC_URL,
      indexerUrl: "https://indexer.example.test",
      proverUrl: "https://prover.example.test",
      fetch,
    });

    await expect(client.getAccount(address(TEST_OWNER))).rejects.toMatchObject({
      code: "CLIENT_RPC",
    });
    expect(calls.length).toBe(1);
  });

  it("serializes bigint request params through the same wire codec", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonRpcResponse("1", { context: { slot: 1 }, value: null })
    );

    const client = await createRingsClient({
      solanaRpcUrl: RPC_URL,
      indexerUrl: "https://indexer.example.test",
      proverUrl: "https://prover.example.test",
      fetch,
    });

    await expect(client.getAccount(address(TEST_OWNER))).resolves.toBeUndefined();
    const payload = JSON.parse(calls[0]?.body ?? "{}") as { method: string };
    expect(payload.method).toBe("getAccountInfo");
  });
});
