import { wellKnownMint } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { allowedTokensForInstance } from "./overview-data";

describe("allowedTokensForInstance", () => {
  it("uses the mainnet USDC mint for a mainnet RPC URL", () => {
    const tokens = allowedTokensForInstance({
      chainRpcUrl: "https://api.mainnet-beta.solana.com",
    });
    expect(tokens).toEqual([{ mint: wellKnownMint("USDC", "mainnet-beta"), symbol: "USDC" }]);
  });

  it("uses the devnet USDC mint for a devnet RPC URL", () => {
    const tokens = allowedTokensForInstance({ chainRpcUrl: "https://api.devnet.solana.com" });
    expect(tokens).toEqual([{ mint: wellKnownMint("USDC", "devnet"), symbol: "USDC" }]);
  });

  it("falls back to devnet (not mainnet) for a custom URL naming neither cluster", () => {
    // Matches the API's canonical inferCluster: an unrecognized URL is the devnet
    // sandbox, so we must never advertise mainnet USDC against a devnet instance.
    const tokens = allowedTokensForInstance({
      chainRpcUrl: "https://rpc.example.com/?api-key=secret",
    });
    expect(tokens).toEqual([{ mint: wellKnownMint("USDC", "devnet"), symbol: "USDC" }]);
  });
});
