import { describe, expect, it } from "vitest";
import { createRingsClient, type RingsSolanaRpc } from "./client.js";

const CONFIG = {
  solanaRpcUrl: "http://127.0.0.1:1/rpc",
  indexerUrl: "http://127.0.0.1:1",
  proverUrl: "http://127.0.0.1:1",
  allowInsecureHttp: true,
};

describe("createRingsClient", () => {
  it("replaces the client's Solana RPC when the config supplies one", async () => {
    const guarded = {} as RingsSolanaRpc;
    const client = await createRingsClient({ ...CONFIG, solanaRpc: guarded });

    expect(client.solanaRpc).toBe(guarded);
  });

  it("keeps the internally-built Solana RPC when the config supplies none", async () => {
    const client = await createRingsClient(CONFIG);

    // The vendored client built this leg itself, so it carries Kit's RPC
    // methods rather than a caller's override.
    expect(typeof client.solanaRpc.getGenesisHash).toBe("function");
  });
});
