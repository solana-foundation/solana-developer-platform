import type { PaymentTransferSummary } from "@sdp/types/payments";
import { describe, expect, it } from "vitest";
import { providerTransferDetailRows } from "./provider-transfer-details";

function transferFixture(overrides: Partial<PaymentTransferSummary>): PaymentTransferSummary {
  return {
    id: "xfr_test",
    custodyWalletId: "cwlt_test",
    providerWalletId: "wallet_test",
    status: "completed",
    signature: null,
    rampsMemo: {},
    type: "offramp",
    provider: "moonpay",
    ...overrides,
  };
}

describe("providerTransferDetailRows", () => {
  it("builds MoonPay settlement economics and an explorer link", () => {
    const signature =
      "TestDepos1tS1gnature11111111111111111111111111111111111111111111111111111111111111111111";
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_settled",
        signature,
        providerReference: "moonpay_transaction",
        settlement: {
          provider: "moonpay",
          status: "completed",
          transactionId: "moonpay_transaction",
          baseCurrencyCode: "SOL",
          baseCurrencyAmount: 25,
          quoteCurrencyCode: "USD",
          quoteCurrencyAmount: 0.2,
          feeAmount: 2,
          extraFeeAmount: 0,
          networkFeeAmount: 0.27,
          areFeesIncluded: true,
          usdRate: 1,
          cryptoTransactionId: signature,
        },
      }),
      { cluster: "devnet" },
      (key) => key
    );
    expect(rows.map(({ key, value }) => [key, value])).toEqual([
      [
        "DashboardPayments.transferDetails.receipt",
        "DashboardPayments.transferDetails.viewReceipt",
      ],
      ["DashboardPayments.transferDetails.providerFee", "2.00 SOL"],
      ["DashboardPayments.transferDetails.networkFee", "0.27 SOL"],
      ["DashboardPayments.transferDetails.exchangeRate", "1 USD = 125 SOL"],
      ["DashboardPayments.transferDetails.solanaSignature", "TestDe…1111"],
    ]);
    expect(rows[0]).toMatchObject({
      href: "https://buy.moonpay.com/v2/transaction-tracker?transactionId=moonpay_transaction",
    });
    expect(rows[4]).toMatchObject({
      href: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      copyValue: signature,
      mono: true,
    });
  });

  it("omits unavailable MoonPay receipt and optional settlement rows", () => {
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_partial",
        status: "failed",
        type: "onramp",
        providerReference: undefined,
        settlement: {
          provider: "moonpay",
          status: "failed",
          transactionId: "moonpay_transaction",
          baseCurrencyCode: "USD",
          baseCurrencyAmount: 25,
          quoteCurrencyCode: "SOL",
          quoteCurrencyAmount: 0,
          feeAmount: 2,
          extraFeeAmount: 0,
          networkFeeAmount: 0,
          areFeesIncluded: true,
          usdRate: 1,
        },
      }),
      { cluster: "devnet" },
      (key) => key
    );

    expect(rows).toEqual([
      {
        key: "DashboardPayments.transferDetails.providerFee",
        label: "DashboardPayments.transferDetails.providerFee",
        value: "2.00 USD",
      },
    ]);
  });

  it("shows a sale's quoted payout only when the provider paid out something else", () => {
    const sale = (fiatPayout: { amount: string; currency: string }) =>
      providerTransferDetailRows(
        transferFixture({ fiatAmount: "20.69", fiatCurrency: "usd", fiatPayout }),
        { cluster: "devnet" },
        (key) => key
      );

    expect(sale({ amount: "20.82", currency: "USD" })).toEqual([
      {
        key: "DashboardPayments.transferDetails.quotedPayout",
        label: "DashboardPayments.transferDetails.quotedPayout",
        value: "20.69 USD",
      },
    ]);
    expect(sale({ amount: "20.690", currency: "USD" })).toEqual([]);
  });

  it.each([
    { type: "transfer", provider: "moonpay" },
    { type: "offramp", provider: undefined },
    { type: "offramp", provider: "stripe" },
  ] as const)("contributes nothing for a $type from $provider", ({ type, provider }) => {
    expect(
      providerTransferDetailRows(
        transferFixture({
          id: "xfr_unsupported",
          type,
          provider,
          providerReference: undefined,
        }),
        { cluster: "devnet" },
        (key) => key
      )
    ).toEqual([]);
  });
});
