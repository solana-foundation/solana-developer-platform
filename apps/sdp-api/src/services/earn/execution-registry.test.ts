import * as solanaRpc from "@sdp/rpc/solana";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { resolveVaultDirectClient } from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";

const executionEnv = {
  SOLANA_NETWORK: "devnet",
  SOLANA_DEVNET_RPC_URL: "https://rpc.example.invalid",
} as Env;
const depositInput = {
  providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  owner: "11111111111111111111111111111112",
  amount: "1",
};

afterEach(() => vi.restoreAllMocks());

describe("resolveVaultDirectClient", () => {
  it("keeps resolution I/O-free and preserves inherited provider capabilities", () => {
    const createRpc = vi.spyOn(solanaRpc, "createRpc");
    const client = resolveVaultDirectClient(executionEnv, "kamino", createVaultDeadline());

    expect(client).not.toBeNull();
    expect(typeof (client as unknown as Record<string, unknown>).listStrategyMetrics).toBe(
      "function"
    );
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("resolves every provider that can move money", () => {
    for (const provider of ["kamino", "veda", "jupiter_lend"]) {
      const client = resolveVaultDirectClient(executionEnv, provider, createVaultDeadline());
      expect(client, provider).not.toBeNull();
      expect(client?.provider, provider).toBe(provider);
      expect(typeof client?.listStrategies, provider).toBe("function");
    }
  });

  it("answers null for providers this deployment cannot execute", () => {
    for (const provider of ["ground", "upshift", "perena", "not-a-provider", "__proto__", ""]) {
      expect(
        resolveVaultDirectClient(executionEnv, provider, createVaultDeadline()),
        provider
      ).toBeNull();
    }
  });

  it("refuses Veda work on the missing mainnet deployment before RPC", async () => {
    const createRpc = vi.spyOn(solanaRpc, "createRpc");
    const client = resolveVaultDirectClient(executionEnv, "veda", createVaultDeadline());
    if (!client) throw new Error("expected a Veda vault-direct client");

    await expect(
      client.buildVaultDeposit(
        { env: {}, environment: "production" },
        { ...depositInput, minSharesOut: "1" }
      )
    ).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_CONFIGURED" });
    expect(createRpc).not.toHaveBeenCalled();
  });
});
