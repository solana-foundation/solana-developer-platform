import type { TokenTransactionListItem } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { buildHomeActivityRows, fetchOrgIssuanceActivity } from "./home-page.data";

const t = (key: MessageKey, _values?: TranslationValues) => key;

const issuanceItem = {
  token: {
    id: "tok_1",
    name: "USD Coin",
    symbol: "USDC",
    mintAddress: "mint_1",
  },
  transaction: {
    id: "ttx_1",
    tokenId: "tok_1",
    organizationId: "org_1",
    type: "mint",
    status: "confirmed",
    idempotencyKey: null,
    idempotencyFingerprint: null,
    signature: "sig_1",
    serializedTx: null,
    params: { amount: "12.5", destination: "wallet_1" },
    slot: null,
    blockTime: null,
    fee: null,
    error: null,
    initiatedByKeyId: null,
    createdAt: "2026-07-17T15:00:00.000Z",
    updatedAt: "2026-07-17T15:00:00.000Z",
  },
} satisfies TokenTransactionListItem;

describe("home issuance activity", () => {
  it("loads the project-wide activity in one request", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [issuanceItem] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(fetchOrgIssuanceActivity(request, t, 20)).resolves.toEqual({
      ok: true,
      data: [issuanceItem],
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/v1/issuance/transactions?page=1&pageSize=20");
  });

  it("preserves the aggregate endpoint token metadata in activity rows", () => {
    expect(buildHomeActivityRows([], [issuanceItem], t)).toEqual([
      expect.objectContaining({
        id: "issuance-ttx_1",
        token: "USDC",
        amount: "12.5",
        address: "wallet_1",
      }),
    ]);
  });
});
