import { getSolanaConfig } from "@sdp/rpc";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { scopeEnvToCluster } from "./cluster-env";

describe("scopeEnvToCluster", () => {
  it("copies an already-devnet environment without changing its provider fan", () => {
    const input = {
      SOLANA_NETWORK: "devnet",
      SOLANA_RPC_URL: "https://devnet.example.invalid",
      SOLANA_RPC_HELIUS_URL: "https://helius-devnet.example.invalid",
      KORA_RPC_URL: "https://kora.example.invalid",
    } as Env;

    const scoped = scopeEnvToCluster(input, "devnet");

    expect(scoped).toEqual(input);
    expect(scoped).not.toBe(input);
  });

  it("uses the mainnet override and clears default-cluster providers and Kora", () => {
    const scoped = scopeEnvToCluster(
      {
        SOLANA_NETWORK: "devnet",
        SOLANA_RPC_URL: "https://devnet.example.invalid",
        SOLANA_MAINNET_RPC_URL: "https://mainnet.example.invalid",
        SOLANA_RPC_DEFAULT_PROVIDER: "helius",
        SOLANA_RPC_HELIUS_URL: "https://helius-devnet.example.invalid",
        SOLANA_RPC_HELIUS_API_KEY: "secret",
        KORA_RPC_URL: "https://kora.example.invalid",
      } as Env,
      "mainnet-beta"
    );

    expect(scoped).toMatchObject({
      SOLANA_NETWORK: "mainnet-beta",
      SOLANA_RPC_URL: "https://mainnet.example.invalid",
    });
    expect(scoped.SOLANA_RPC_DEFAULT_PROVIDER).toBeUndefined();
    expect(scoped.SOLANA_RPC_HELIUS_URL).toBeUndefined();
    expect(scoped.SOLANA_RPC_HELIUS_API_KEY).toBeUndefined();
    expect(scoped.KORA_RPC_URL).toBeUndefined();
  });

  it("fails closed with a cluster-named error when mainnet has no override", () => {
    const scoped = scopeEnvToCluster(
      {
        SOLANA_NETWORK: "devnet",
        SOLANA_RPC_URL: "https://devnet.example.invalid",
      } as Env,
      "mainnet-beta"
    );

    expect(scoped.SOLANA_RPC_URL).toBeUndefined();
    expect(() => getSolanaConfig(scoped)).toThrow(
      "No Solana RPC endpoint is configured for mainnet-beta"
    );
  });

  it("uses the devnet override from a mainnet-default deployment", () => {
    const scoped = scopeEnvToCluster(
      {
        SOLANA_NETWORK: "mainnet-beta",
        SOLANA_RPC_URL: "https://mainnet.example.invalid",
        SOLANA_DEVNET_RPC_URL: "https://devnet.example.invalid",
      } as Env,
      "devnet"
    );

    expect(getSolanaConfig(scoped)).toEqual({
      network: "devnet",
      rpcUrl: "https://devnet.example.invalid",
    });
  });

  it("never mutates the input", () => {
    const input = {
      SOLANA_NETWORK: "devnet",
      SOLANA_RPC_URL: "https://devnet.example.invalid",
      SOLANA_MAINNET_RPC_URL: "https://mainnet.example.invalid",
      KORA_RPC_URL: "https://kora.example.invalid",
    } as Env;
    const snapshot = { ...input };

    scopeEnvToCluster(input, "mainnet-beta");

    expect(input).toEqual(snapshot);
  });
});
