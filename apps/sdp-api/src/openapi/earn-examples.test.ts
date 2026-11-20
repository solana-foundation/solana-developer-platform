import { refreshOperationSchema, submitOperationSchema } from "@sdp/types/operations";
import { describe, expect, it } from "vitest";
import { prepareEarnDepositSchema, prepareEarnWithdrawalSchema } from "@/routes/earn/core/schemas";
import { emptyOperationBodySchema } from "@/routes/operations/schemas";
import { earnDiscoveryResponseSchema, earnPositionsResponseSchema } from "./schemas/earn-core";
import { EARN_STRATEGY_EXAMPLE } from "./schemas/earn-examples";
import { createOpenApiDocument } from "./spec";

const meta = { requestId: "req_example", timestamp: "2026-11-06T18:00:00.000Z" };

describe("Earn core contract examples", () => {
  const document = createOpenApiDocument();

  it.each([
    ["/v1/earn/deposit", prepareEarnDepositSchema],
    ["/v1/earn/withdraw", prepareEarnWithdrawalSchema],
    ["/v1/operations/{operationId}/submit", submitOperationSchema],
    ["/v1/operations/{operationId}/refresh", refreshOperationSchema],
    ["/v1/operations/{operationId}/cancel", emptyOperationBodySchema],
  ] as const)("validates the actual OpenAPI request example for %s", (path, schema) => {
    const request = document.paths[path]?.post?.requestBody;
    if (request === undefined || "$ref" in request) throw new Error(`Missing request for ${path}`);
    const published = request.content["application/json"]?.schema;
    if (published === undefined || "$ref" in published || published.example === undefined)
      throw new Error(`Missing request example for ${path}`);
    expect(schema.safeParse(published.example)).toMatchObject({ success: true });
  });

  it("keeps unknown observation times explicit in discovery", () => {
    const result = earnDiscoveryResponseSchema.parse({
      data: {
        strategies: [
          {
            ...EARN_STRATEGY_EXAMPLE,
            rate: {
              value: "0.045113",
              measure: "apy",
              basis: "provider_reported",
              observedAt: null,
              source: {
                provider: "kamino",
                providerReference: EARN_STRATEGY_EXAMPLE.providerReference,
              },
            },
            capabilities: { deposit: true, withdraw: true, admission: "evaluated_on_prepare" },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
      meta,
    });
    expect(result.data.strategies[0]?.rate.observedAt).toBeNull();
  });

  it("does not require fabricated balances or acquisition dates for discovered holdings", () => {
    const result = earnPositionsResponseSchema.parse({
      data: {
        positions: [
          {
            id: "discovered_position",
            source: { ownerAddress: "owner" },
            provider: "kamino",
            providerReference: EARN_STRATEGY_EXAMPLE.providerReference,
            label: "USDC strategy",
            tokenMint: EARN_STRATEGY_EXAMPLE.depositMints[0],
            shareMint: EARN_STRATEGY_EXAMPLE.shareMint,
            createdAt: null,
            closedAt: null,
            discovered: true,
            costBasisKnown: false,
            feeSponsored: false,
          },
        ],
        hasMore: false,
        nextCursor: null,
        coverage: "integrated_catalogue_positions",
        discovery: { strategyCount: 1, unavailableStrategyCount: 1 },
      },
      meta,
    });
    expect(result.data.positions[0]?.tokenValue).toBeUndefined();
    expect(result.data.positions[0]?.createdAt).toBeNull();
  });

  it("prepares deposits by strategy and withdrawals by position using explicit token units", () => {
    expect(
      prepareEarnDepositSchema.safeParse({
        strategyId: "strategy",
        source: { walletId: "wallet" },
        amount: { mint: "mint", value: "25" },
        slippageBps: 50,
      }).success
    ).toBe(true);
    expect(
      prepareEarnWithdrawalSchema.safeParse({ positionId: "position", amount: { kind: "all" } })
        .success
    ).toBe(true);
    expect(
      prepareEarnDepositSchema.safeParse({
        strategyId: "strategy",
        source: { walletId: "wallet", ownerAddress: "owner" },
        amount: { mint: "mint", value: "25" },
      }).success
    ).toBe(false);
  });
});
