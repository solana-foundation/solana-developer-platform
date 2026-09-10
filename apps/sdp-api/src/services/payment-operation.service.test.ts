import { SOL_MINT, wellKnownMint } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { normalizePaymentToken, rampTransferTokenMint } from "./payment-operation.service";

const envFor = (network: "devnet" | "mainnet-beta") =>
  ({ SOLANA_NETWORK: network, SOLANA_RPC_URL: "https://rpc.example.invalid" }) as Env;

describe("cluster-scoped payment token normalization", () => {
  it("resolves well-known symbols to the scoped cluster mint", () => {
    expect(normalizePaymentToken("USDC", envFor("devnet"))).toBe(wellKnownMint("USDC", "devnet"));
    expect(normalizePaymentToken("usdc", envFor("mainnet-beta"))).toBe(
      wellKnownMint("USDC", "mainnet-beta")
    );
  });

  it("resolves native SOL independently of cluster", () => {
    expect(normalizePaymentToken("SOL", envFor("devnet"))).toBe(SOL_MINT);
    expect(normalizePaymentToken("sol", envFor("mainnet-beta"))).toBe(SOL_MINT);
  });

  it("resolves ramp rails to the scoped cluster mint", () => {
    expect(rampTransferTokenMint("usdc.solana", envFor("devnet"))).toBe(
      wellKnownMint("USDC", "devnet")
    );
    expect(rampTransferTokenMint("usdc.solana", envFor("mainnet-beta"))).toBe(
      wellKnownMint("USDC", "mainnet-beta")
    );
  });
});
