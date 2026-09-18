import { afterEach, describe, expect, it, vi } from "vitest";
import type { DemoConfig } from "./env";
import { EmbeddedYieldClient } from "./sdp-client";

const config: DemoConfig = {
  SDP_API_BASE_URL: "http://127.0.0.1:8787",
  SDP_API_KEY: "test-api-key",
  DEMO_WALLET_PRIVATE_KEY: "test-private-key",
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
};

describe("EmbeddedYieldClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes the sponsor through without exposing the API key in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          transaction: {
            transactionId: "transaction",
            transaction: "base64",
            lastValidBlockHeight: "100",
            ownerAddress: "customer",
            feePayer: "northstar",
            provider: "provider",
          },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new EmbeddedYieldClient(config).buildDeposit({
      strategyId: "strategy",
      ownerAddress: "customer",
      feePayer: "northstar",
      amount: "1",
      sourceTokenMint: "usdc",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      ownerAddress: "customer",
      feePayer: "northstar",
    });
    expect(new Headers(request.headers).get("Authorization")).toBe(
      "Bearer test-api-key"
    );
    expect(request.body).not.toContain("test-api-key");
  });

  it("reads a movement through the chain-aware detail endpoint", async () => {
    const movement = {
      movementId: "movement/with space",
      status: "confirmed",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { movement } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new EmbeddedYieldClient(config).getMovement(movement.movementId)
    ).resolves.toEqual(movement);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8787/v1/earn/external-wallet/movements/movement%2Fwith%20space"
    );
  });
});
