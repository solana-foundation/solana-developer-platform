import { describe, expect, it } from "vitest";
import { createGuardedSolanaRpcTransport } from "./solana-transport.js";

const RPC_URL = "https://rpc.example.test/rpc?api-key=secret";

describe("createGuardedSolanaRpcTransport", () => {
  it("serializes u64 wire params exactly through the bigint-aware codec", async () => {
    let body = "";
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      body = typeof init?.body === "string" ? init.body : "";
      return new Response('{"jsonrpc":"2.0","id":"1","result":null}', { status: 200 });
    };
    const transport = createGuardedSolanaRpcTransport({ url: RPC_URL, fetch });

    // A u64 no Number can hold: a Number-bound replacer would round these
    // digits, so the exact digits on the wire prove the payload rode the
    // bigint-aware codec the responses are parsed with.
    await transport({
      payload: { jsonrpc: "2.0", id: "1", method: "getBlock", params: [12345678901234567890n] },
    });

    expect(body).toMatch(/"params":\[12345678901234567890\]/);
  });
});
