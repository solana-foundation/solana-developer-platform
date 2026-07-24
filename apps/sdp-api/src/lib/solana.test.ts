import { getSolanaConfig, resolveDefaultSolanaRpcUrl } from "@sdp/rpc";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";

describe("solana config resolution", () => {
  it("prefers the configured managed default provider over the generic RPC URL", () => {
    const env = {
      SOLANA_NETWORK: "devnet",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
      SOLANA_RPC_DEFAULT_PROVIDER: "helius",
      SOLANA_RPC_HELIUS_URL: "https://devnet.helius-rpc.com/?api-key={API_KEY}",
      SOLANA_RPC_HELIUS_API_KEY: "test-helius-key",
    } as Partial<Env> as Env;

    expect(resolveDefaultSolanaRpcUrl(env)).toBe(
      "https://devnet.helius-rpc.com/?api-key=test-helius-key"
    );
    expect(getSolanaConfig(env)).toEqual({
      network: "devnet",
      rpcUrl: "https://devnet.helius-rpc.com/?api-key=test-helius-key",
    });
  });

  it("falls back to the generic RPC URL when the preferred provider is unavailable", () => {
    const env = {
      SOLANA_NETWORK: "devnet",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
      SOLANA_RPC_DEFAULT_PROVIDER: "helius",
    } as Partial<Env> as Env;

    expect(resolveDefaultSolanaRpcUrl(env)).toBe("https://api.devnet.solana.com");
    expect(getSolanaConfig(env)).toEqual({
      network: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
    });
  });

  it("resolves Nodit as the deployment default through URL-path authentication", () => {
    const env = {
      SOLANA_NETWORK: "devnet",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
      SOLANA_RPC_DEFAULT_PROVIDER: "nodit",
      SOLANA_RPC_NODIT_URL: "https://rpc.proxy.test/nodit/{API_KEY}",
      SOLANA_RPC_NODIT_API_KEY: "test+/= key",
    } as Partial<Env> as Env;

    expect(resolveDefaultSolanaRpcUrl(env)).toBe(
      "https://rpc.proxy.test/nodit/test%2B%2F%3D%20key"
    );
    expect(getSolanaConfig(env)).toEqual({
      network: "devnet",
      rpcUrl: "https://rpc.proxy.test/nodit/test%2B%2F%3D%20key",
    });
  });

  it("uses the Nodit URL as configured when no separate key is provided", () => {
    const env = {
      SOLANA_RPC_DEFAULT_PROVIDER: "nodit",
      SOLANA_RPC_NODIT_URL: "https://rpc.proxy.test/nodit/{API_KEY}",
    } as Partial<Env> as Env;

    expect(resolveDefaultSolanaRpcUrl(env)).toBe("https://rpc.proxy.test/nodit/{API_KEY}");
  });

  it("throws when no RPC endpoint is configured", () => {
    expect(() => getSolanaConfig({ SOLANA_NETWORK: "devnet" } as Partial<Env> as Env)).toThrow(
      "No Solana RPC endpoint is configured"
    );
  });
});
