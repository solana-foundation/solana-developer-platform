import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import type { PaymentTransferStatus, PaymentTransferSummary } from "@sdp/types/payments";
import type { TokenTransactionListItem } from "@sdp/types/tokens";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import {
  buildHomeActivityRows,
  computeTodaysVolume,
  fetchOrgIssuanceActivity,
  filterHomeActivityRowsByFlags,
  priceTodaysVolume,
} from "./home-page.data";

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
        status: "confirmed",
      }),
    ]);
  });

  it("carries a failed deploy's status so the card can mark it", () => {
    // A failed deploy has no destination and often no signature; before the
    // status rode along, the row was indistinguishable from a successful one.
    const failedDeploy = {
      ...issuanceItem,
      transaction: {
        ...issuanceItem.transaction,
        id: "ttx_2",
        type: "deploy",
        status: "failed",
        signature: null,
        params: {},
        error: "insufficient funds",
      },
    } satisfies TokenTransactionListItem;

    expect(buildHomeActivityRows([], [failedDeploy], t)).toEqual([
      expect.objectContaining({
        id: "issuance-ttx_2",
        type: "Deploy",
        status: "failed",
        address: "—",
      }),
    ]);
  });

  it("carries the payment transfer status", () => {
    const transfer = {
      id: "xfr_status",
      direction: "outbound",
      status: "pending",
      token: "mint",
      amount: "1",
      destination: "wallet_9",
      createdAt: "2026-07-17T15:00:00.000Z",
    } as unknown as PaymentTransferSummary;

    const [row] = buildHomeActivityRows([transfer], [], t);

    expect(row?.status).toBe("pending");
  });

  it("removes issuance rows when the Issuance module is disabled", () => {
    const transfer = {
      id: "xfr_visible",
      direction: "outbound",
      status: "confirmed",
      token: "mint",
      amount: "1",
      destination: "wallet_9",
      createdAt: "2026-07-17T15:00:00.000Z",
    } as unknown as PaymentTransferSummary;
    const rows = buildHomeActivityRows([transfer], [issuanceItem], t);

    expect(filterHomeActivityRowsByFlags(rows, { issuance: false })).toEqual([
      expect.objectContaining({ id: "payment-xfr_visible", sourceKind: "payments" }),
    ]);
  });

  it("renders a well-known mint as its symbol rather than the raw address", () => {
    const transfer = {
      id: "xfr_1",
      direction: "outbound",
      token: WELL_KNOWN_TOKENS.USDC.mints.devnet.address,
      amount: "100",
      destination: "wallet_2",
      createdAt: "2026-07-17T15:00:00.000Z",
    } as unknown as PaymentTransferSummary;

    const [row] = buildHomeActivityRows([transfer], [], t);

    expect(row?.token).toBe("USDC");
  });

  it("names a token this org issued rather than shortening its mint", () => {
    const mint = "AcmeQA1111111111111111111111111111111111111";
    const transfer = {
      id: "xfr_issued",
      direction: "outbound",
      token: mint,
      amount: "100",
      destination: "wallet_2",
      createdAt: "2026-07-17T15:00:00.000Z",
    } as unknown as PaymentTransferSummary;

    const [row] = buildHomeActivityRows([transfer], [], t, { [mint]: "ACME" });

    expect(row?.token).toBe("ACME");
  });

  it("shortens an uncatalogued mint instead of printing all 44 characters", () => {
    const transfer = {
      id: "xfr_2",
      direction: "outbound",
      token: "9xQeWvG816bUx9EPfuxEzHh9VY5kvJkFqRk3nJvHnLpQ",
      amount: "5",
      destination: "wallet_3",
      createdAt: "2026-07-17T15:00:00.000Z",
    } as unknown as PaymentTransferSummary;

    const [row] = buildHomeActivityRows([transfer], [], t);

    expect(row?.token).toBe("9xQeWv…nLpQ");
  });
});

describe("token mint passthrough", () => {
  it("keeps the raw mint so the client can name a token this builder cannot", () => {
    // The builder only knows issued-token symbols. A holding the organization did
    // not issue used to degrade to a shortened mint with no way back to a symbol.
    const mint = "9xQeWvG816bUx9EPfuxEzHh9VY5kvJkFqRk3nJvHnLpQ";
    const [row] = buildHomeActivityRows(
      [
        {
          id: "t1",
          createdAt: "2026-07-30T10:00:00.000Z",
          token: mint,
          amount: "12",
          direction: "inbound",
        } as never,
      ],
      [],
      ((key: string) => key) as never
    );

    expect(row.tokenMint).toBe(mint);
  });
});

describe("today's volume", () => {
  const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
  const TODAY = "2026-10-23T09:00:00.000Z";

  function sent(
    token: string | undefined,
    amount: string,
    status: PaymentTransferStatus = "finalized",
    createdAt = TODAY
  ): PaymentTransferSummary {
    return {
      id: `transfer_${token}_${amount}_${status}`,
      custodyWalletId: "wallet_1",
      providerWalletId: "provider_wallet_1",
      status,
      signature: "sig_1",
      rampsMemo: {},
      direction: "outbound",
      token,
      amount,
      createdAt,
    };
  }

  function held(mint: string, usdPrice?: number): CustodyWalletTokenBalance {
    return { token: "T", mint, amount: "1", uiAmount: "1", decimals: 6, usdPrice };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps today's amounts per mint, since SOL and USDC do not add", () => {
    const volume = computeTodaysVolume([
      sent(SOL_MINT, "0.5", "completed"),
      sent(USDC_MINT, "10"),
      sent(USDC_MINT, "5", "confirmed"),
      sent(USDC_MINT, "100", "finalized", "2026-10-22T09:00:00.000Z"),
    ]);

    expect(volume).toEqual({
      transferCount: 3,
      amountByMint: { [SOL_MINT]: 0.5, [USDC_MINT]: 15 },
      complete: true,
    });
  });

  it("counts only transfers that succeeded", () => {
    const unsuccessful: PaymentTransferStatus[] = [
      "pending",
      "processing",
      "failed",
      "canceled",
      "expired",
      "awaiting_payment",
      "settling",
    ];
    const volume = computeTodaysVolume(unsuccessful.map((status) => sent(USDC_MINT, "10", status)));

    expect(volume).toEqual({ transferCount: 0, amountByMint: {}, complete: true });
  });

  it("marks the day incomplete when a counted transfer has no token to price", () => {
    expect(computeTodaysVolume([sent(undefined, "10")])).toEqual({
      transferCount: 1,
      amountByMint: {},
      complete: false,
    });
  });

  it("prices each mint with the market price its balance row carried", () => {
    const volume = computeTodaysVolume([sent(SOL_MINT, "2"), sent(USDC_MINT, "10")]);

    // SOL at the API's $150, USDC at a dollar as a well-known stablecoin.
    expect(priceTodaysVolume(volume, [held(SOL_MINT, 150)])).toEqual({ kind: "usd", usd: 310 });
  });

  it("reads as a count when a token moved today has no price, rather than adding SOL to dollars", () => {
    const volume = computeTodaysVolume([sent(SOL_MINT, "2"), sent(USDC_MINT, "10")]);

    expect(priceTodaysVolume(volume, [held(SOL_MINT)])).toEqual({ kind: "count", count: 2 });
  });

  it("reads as a count when the day is incomplete", () => {
    const volume = computeTodaysVolume([sent(undefined, "10"), sent(USDC_MINT, "10")]);

    expect(priceTodaysVolume(volume, [])).toEqual({ kind: "count", count: 2 });
  });

  it("is a measured $0.00 on a day without payments", () => {
    expect(priceTodaysVolume(computeTodaysVolume([]), [])).toEqual({ kind: "usd", usd: 0 });
  });
});
