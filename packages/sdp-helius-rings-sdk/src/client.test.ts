import { ZolanaClient } from "@heliuslabs/zolana/client";
import { SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";

/**
 * The client's own Solana RPC leg must dial through the injected fetch, the
 * same one the gateway passes for the indexer, prover and Ring RPC legs. A leg
 * that fell back to the global fetch would bypass the API's egress guard: a
 * tenant-supplied RPC URL could then rebind its DNS to a private or metadata
 * address after passing the write-time check.
 */
describe("ZolanaClient Solana RPC transport", () => {
  const RPC_URL = "https://rpc.example/?api-key=super-secret-key";

  function clientWith(fetchImpl: typeof globalThis.fetch): ZolanaClient {
    return new ZolanaClient({
      solanaRpcUrl: RPC_URL,
      indexerUrl: "https://indexer.example",
      proverUrl: "https://prover.example",
      fetch: fetchImpl,
    });
  }

  it("sends JSON-RPC reads through the injected fetch", async () => {
    const calls: Array<{ url: string; body: string; method: string }> = [];
    const client = clientWith(((input, init) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        method: init?.method ?? "GET",
      });
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }) as typeof globalThis.fetch);

    const height = await client.solanaRpc.getBlockHeight().send();

    expect(height).toBe(42n);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(RPC_URL);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain('"method":"getBlockHeight"');
  });

  it("surfaces a non-2xx as Kit's HTTP transport error", async () => {
    const client = clientWith((() =>
      Promise.resolve(
        new Response("gone", { status: 503, statusText: "unavailable" })
      )) as typeof globalThis.fetch);

    const failure = client.solanaRpc.getBlockHeight().send();
    await expect(failure).rejects.toThrow(SolanaError);
    await expect(failure).rejects.toMatchObject({
      context: expect.objectContaining({ statusCode: 503 }),
    });
  });
});
