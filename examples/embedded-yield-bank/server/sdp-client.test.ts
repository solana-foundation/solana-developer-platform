import { afterEach, describe, expect, it, vi } from "vitest";
import type { YieldMovement } from "../src/types.ts";
import type { DemoConfig } from "./env.ts";
import { EmbeddedYieldClient } from "./sdp-client.ts";

const config: DemoConfig = {
  SDP_API_BASE_URL: "http://127.0.0.1:8787",
  SDP_API_KEY: "test-api-key",
  DEMO_WALLET_PRIVATE_KEY: "test-private-key",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  DEMO_API_PORT: 4174,
  NORTHSTAR_DEMO_SESSION_TOKEN: "test-session-token-with-enough-entropy",
};

describe("EmbeddedYieldClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fails explicitly when movement polling times out before settlement", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: { movement: movement("confirmed") } })
        )
    );

    await expect(
      new EmbeddedYieldClient(config).waitForMovement("movement", 0)
    ).rejects.toThrow("still confirmed");
  });

  it("returns finalized movements as terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: { movement: movement("finalized") } })
        )
    );

    await expect(
      new EmbeddedYieldClient(config).waitForMovement("movement", 0)
    ).resolves.toMatchObject({ status: "finalized" });
  });

  it("passes the optional sponsor through the documented build request", async () => {
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
  });
});

function movement(status: YieldMovement["status"]): YieldMovement {
  return {
    movementId: "movement",
    positionId: "position",
    provider: "provider",
    direction: "deposit",
    status,
    signature: "signature",
    amount: "1",
    denomination: "usdc",
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    settledAt: status === "finalized" ? "2026-01-01T00:00:01.000Z" : null,
  };
}
