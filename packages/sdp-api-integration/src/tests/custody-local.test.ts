import { transferLamportsFromEnv } from "@/services/solana/funding";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TokenApiResponse } from "../helpers/api-types";
import {
  KORA_CONFIGURED,
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  cleanupIntegrationSuite,
  env,
  initIntegrationSuite,
  request as rawRequest,
  requestWithApiKey,
  resetIntegrationState,
} from "../helpers/integration";

async function callRpc<T>(method: string, params: unknown[]): Promise<T> {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL is not configured for integration tests.");
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const payload = (await response.json()) as { result?: T; error?: { message?: string } };
  if (payload.error) {
    throw new Error(payload.error.message ?? `RPC error calling ${method}`);
  }

  return payload.result as T;
}

async function ensureFunded(recipient: string, minimumLamports: number) {
  const balance = await callRpc<{ value: number }>("getBalance", [
    recipient,
    { commitment: "confirmed" },
  ]);

  if (balance.value >= minimumLamports) {
    return;
  }

  const topUpAmount = BigInt(minimumLamports - balance.value);
  await transferLamportsFromEnv(env, recipient, topUpAmount);
}

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Custody Local Signing", () => {
  let apiKeyHash: string;
  const request = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    await resetIntegrationState(apiKeyHash);
  });

  it("initializes local custody and uses it for deployments", { timeout: 120000 }, async () => {
    const initRes = await request("/v1/custody/initialize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "local", walletLabel: "Integration Wallet" }),
    });

    expect(initRes.status).toBe(201);
    const initBody = (await initRes.json()) as {
      data: { configId: string; publicKey: string; walletId: string };
    };

    const { configId, publicKey } = initBody.data;
    expect(publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    const configRes = await request("/v1/custody/config");

    expect(configRes.status).toBe(200);
    const configBody = (await configRes.json()) as {
      data: { config: { id: string; provider: string; publicKey: string } };
    };

    expect(configBody.data.config.id).toBe(configId);
    expect(configBody.data.config.provider).toBe("local");
    expect(configBody.data.config.publicKey).toBe(publicKey);

    const configRow = await env.DB.prepare(
      "SELECT config_encrypted FROM custody_configs WHERE id = ?"
    )
      .bind(configId)
      .first<{ config_encrypted: string }>();

    expect(configRow?.config_encrypted).toBeTruthy();
    expect(() => JSON.parse(configRow?.config_encrypted ?? "")).toThrow();

    // If Kora is enabled, it sponsors transaction fees so the custody wallet doesn't need SOL.
    if (!KORA_CONFIGURED) {
      await ensureFunded(publicKey, 500_000_000);
    }

    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Custody Token",
        symbol: "CUST",
        decimals: 6,
        isMintable: true,
        isFreezable: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;
    expect(deployed.data.token.mintAuthority).toBe(publicKey);
  });

  it("requires auth for custody endpoints", async () => {
    const configRes = await rawRequest("/v1/custody/config");
    expect(configRes.status).toBe(401);

    const initRes = await rawRequest("/v1/custody/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local" }),
    });
    expect(initRes.status).toBe(401);
  });
});
