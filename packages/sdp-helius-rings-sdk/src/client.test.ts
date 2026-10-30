import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { createRingsClient } from "./client.js";

// The client builds its own Solana RPC transport from `solanaRpcUrl`; the
// transport config is the only way a host reaches that leg. Here it carries a
// refusing dispatcher, so the dial proves the config actually lands on the
// leg: the refusal — not a DNS lookup for the endpoint — is what fails.
describe("createRingsClient transport config", () => {
  it("routes the client's own Solana RPC leg through solanaRpcTransportConfig", async () => {
    const dispatched: unknown[] = [];
    const refusing = {
      dispatch(options: unknown) {
        dispatched.push(options);
        throw new Error("guard refused the dispatch");
      },
    };

    const client = await createRingsClient({
      solanaRpcUrl: "https://rpc.invalid",
      indexerUrl: "https://indexer.invalid",
      proverUrl: "https://prover.invalid",
      solanaRpcTransportConfig: { dispatcher_NODE_ONLY: refusing },
    });

    const error = await client.getBalance(address("11111111111111111111111111111111")).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(dispatched).toHaveLength(1);
    // Zolana classifies the transport failure as an external CLIENT_RPC and
    // collapses the cause — the marker does not survive on purpose.
    expect(error).toMatchObject({ name: "ClientError", message: "CLIENT_RPC" });
  });

  it("leaves the leg on the library transport when no config is given", async () => {
    const client = await createRingsClient({
      solanaRpcUrl: "https://rpc.invalid",
      indexerUrl: "https://indexer.invalid",
      proverUrl: "https://prover.invalid",
    });

    const error = await client.getBalance(address("11111111111111111111111111111111")).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(Error);
  });
});
