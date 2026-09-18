import type { PaymentTransferSummary } from "@sdp/types";
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

  it("builds BVNK on-ramp economics, the sandbox receipt, and the explorer link", () => {
    const hash =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_settled",
        type: "onramp",
        provider: "bvnk",
        settlement: {
          provider: "bvnk",
          status: "COMPLETE",
          payinId: "01a0ab3c-2c02-7788-ab94-d5ce3bbb5db9",
          payoutId: "01a0ab3c-4388-7e84-a501-3b02668d715b",
          fiatCurrency: "USD",
          fiatAmount: "9.9",
          cryptoCurrency: "USDC",
          cryptoAmount: "9.8802",
          feeCurrency: "USD",
          feeAmount: "0.1",
          exchangeRate: 0.998,
          txHash: hash,
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
      ["DashboardPayments.transferDetails.providerFee", "0.10 USD"],
      ["DashboardPayments.transferDetails.exchangeRate", "1 USD = 0.998 USDC"],
      ["DashboardPayments.transferDetails.delivered", "9.8802 USDC"],
      ["DashboardPayments.transferDetails.solanaSignature", "5XGAib…iwcM"],
    ]);
    expect(rows[0]).toMatchObject({
      href: "https://pay.sandbox.bvnk.com/payout/01a0ab3c-4388-7e84-a501-3b02668d715b",
    });
    expect(rows[4]).toMatchObject({
      href: `https://explorer.solana.com/tx/${hash}?cluster=devnet`,
      copyValue: hash,
      mono: true,
    });
  });

  it("derives the production BVNK receipt URL for the mainnet cluster", () => {
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_prod",
        type: "onramp",
        provider: "bvnk",
        settlement: {
          provider: "bvnk",
          status: "COMPLETE",
          payinId: "payin_1",
          payoutId: "payout_prod_1",
          fiatCurrency: "USD",
          fiatAmount: "100",
          cryptoCurrency: "USDC",
          cryptoAmount: "99.5",
          feeCurrency: "USD",
          feeAmount: "0.5",
          exchangeRate: 0.995,
          txHash: "tx_prod_1",
        },
      }),
      { cluster: "mainnet-beta" },
      (key) => key
    );

    expect(rows[0]).toMatchObject({
      href: "https://pay.bvnk.com/payout/payout_prod_1",
    });
  });

  it("omits BVNK detail rows for directions the builder does not serve", () => {
    expect(
      providerTransferDetailRows(
        transferFixture({
          id: "xfr_bvnk_offramp",
          type: "offramp",
          provider: "bvnk",
        }),
        { cluster: "devnet" },
        (key) => key
      )
    ).toEqual([]);
  });
});
