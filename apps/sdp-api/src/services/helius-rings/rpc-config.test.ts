import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { requireRingsHeliusRpcUrl, resolveRingsHeliusRpcConfig } from "./rpc-config";

function envOf(overrides: Partial<Env> = {}): Env {
  return {
    SOLANA_RPC_HELIUS_URL: undefined,
    SOLANA_RPC_HELIUS_API_KEY: undefined,
    ...overrides,
  } as Env;
}

describe("resolveRingsHeliusRpcConfig", () => {
  it("returns the resolved URL when both the endpoint and the key are set", () => {
    const config = resolveRingsHeliusRpcConfig(
      envOf({
        SOLANA_RPC_HELIUS_URL: "https://rpc.example/{API_KEY}",
        SOLANA_RPC_HELIUS_API_KEY: "abc123",
      })
    );

    expect(config.rpcUrl).toBe("https://rpc.example/abc123");
    expect(config.missing).toEqual([]);
  });

  it("reports the endpoint variable as missing when it is not configured", () => {
    const config = resolveRingsHeliusRpcConfig(envOf());

    expect(config.rpcUrl).toBeUndefined();
    expect(config.missing).toEqual(["SOLANA_RPC_HELIUS_URL"]);
  });

  it("reports the API key as missing when the URL still holds the placeholder", () => {
    const config = resolveRingsHeliusRpcConfig(
      envOf({
        SOLANA_RPC_HELIUS_URL: "https://rpc.example/{API_KEY}",
      })
    );

    expect(config.rpcUrl).toBeUndefined();
    expect(config.missing).toEqual(["SOLANA_RPC_HELIUS_API_KEY"]);
  });

  it("passes through a URL that carries its own key", () => {
    const config = resolveRingsHeliusRpcConfig(
      envOf({ SOLANA_RPC_HELIUS_URL: "https://rpc.example/preset-key" })
    );

    expect(config.rpcUrl).toBe("https://rpc.example/preset-key");
    expect(config.missing).toEqual([]);
  });
});

describe("requireRingsHeliusRpcUrl", () => {
  it("returns the resolved URL when the config is complete", () => {
    expect(
      requireRingsHeliusRpcUrl(envOf({ SOLANA_RPC_HELIUS_URL: "https://rpc.example/preset-key" }))
    ).toBe("https://rpc.example/preset-key");
  });

  it("throws a config error naming every missing variable", () => {
    expect(() => requireRingsHeliusRpcUrl(envOf())).toThrowError(
      /Rings Helius RPC is misconfigured: missing SOLANA_RPC_HELIUS_URL/
    );
  });
});
