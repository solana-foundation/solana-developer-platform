import type { PaymentTransferSummary } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { providerTransferDetailRows } from "./provider-transfer-details";

function transferFixture(overrides: Partial<PaymentTransferSummary>): PaymentTransferSummary {
  return {
    id: "xfr_test",
    status: "completed",
    signature: null,
    rampsMemo: {},
    type: "offramp",
    provider: "moonpay",
    ...overrides,
  };
}

describe("providerTransferDetailRows", () => {
  it("builds a MoonPay sell receipt from the bound provider transaction id", () => {
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_123",
        providerReference: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      }),
      { cluster: "devnet" },
      (key) => key
    );

    expect(rows).toContainEqual({
      key: "DashboardPayments.transferDetails.receipt",
      label: "DashboardPayments.transferDetails.receipt",
      value: "DashboardPayments.transferDetails.viewReceipt",
      href: "https://buy.moonpay.com/v2/transaction-tracker?transactionId=772f7a7f-142e-43cf-824f-8d861aefe8bd",
    });
  });

  it("builds MoonPay settlement economics and an explorer link", () => {
    const signature =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
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
      ["DashboardPayments.transferDetails.solanaSignature", "5XGAib…iwcM"],
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

  it.each([
    { type: "transfer", provider: "moonpay" },
    { type: "offramp", provider: undefined },
    { type: "offramp", provider: "moneygram" },
  ] as const)("omits unsupported transfer details", ({ type, provider }) => {
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
