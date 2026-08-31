import { describe, expect, it } from "vitest";
import { providerTransferDetailRows } from "./provider-transfer-details";

describe("providerTransferDetailRows", () => {
  it("builds a MoonPay sell receipt from the bound provider transaction id", () => {
    const rows = providerTransferDetailRows(
      {
        id: "xfr_123",
        status: "completed",
        signature: null,
        rampsMemo: {},
        type: "offramp",
        provider: "moonpay",
        providerReference: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      },
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
      {
        id: "xfr_settled",
        status: "completed",
        signature,
        rampsMemo: {},
        type: "offramp",
        provider: "moonpay",
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
      },
      { cluster: "devnet" },
      (key) => key
    );

    expect(rows).toEqual([
      {
        key: "DashboardPayments.transferDetails.receipt",
        label: "DashboardPayments.transferDetails.receipt",
        value: "DashboardPayments.transferDetails.viewReceipt",
        href: "https://buy.moonpay.com/v2/transaction-tracker?transactionId=moonpay_transaction",
      },
      {
        key: "DashboardPayments.transferDetails.providerFee",
        label: "DashboardPayments.transferDetails.providerFee",
        value: "2.00 SOL",
      },
      {
        key: "DashboardPayments.transferDetails.networkFee",
        label: "DashboardPayments.transferDetails.networkFee",
        value: "0.27 SOL",
      },
      {
        key: "DashboardPayments.transferDetails.exchangeRate",
        label: "DashboardPayments.transferDetails.exchangeRate",
        value: "1 USD = 125 SOL",
      },
      {
        key: "DashboardPayments.transferDetails.solanaSignature",
        label: "DashboardPayments.transferDetails.solanaSignature",
        value: "5XGAib…iwcM",
        href: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        copyValue: signature,
        mono: true,
      },
    ]);
  });

  it("omits unavailable MoonPay receipt and optional settlement rows", () => {
    const rows = providerTransferDetailRows(
      {
        id: "xfr_partial",
        status: "failed",
        signature: null,
        rampsMemo: {},
        type: "onramp",
        provider: "moonpay",
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
      },
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
        {
          id: "xfr_unsupported",
          status: "completed",
          signature: null,
          rampsMemo: {},
          type,
          provider,
          providerReference: undefined,
        },
        { cluster: "devnet" },
        (key) => key
      )
    ).toEqual([]);
  });
});
