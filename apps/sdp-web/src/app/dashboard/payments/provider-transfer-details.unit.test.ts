import type { PaymentTransferSummary } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { isValidBvnkReceiptUrl, providerTransferDetailRows } from "./provider-transfer-details";

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

  it("builds BVNK on-ramp COMPLETE economics, the stored receipt, and the explorer link", () => {
    const hash =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
    const payinId = "01a0ab3c-2c02-7788-ab94-d5ce3bbb5db9";
    const payoutId = "01a0ab3c-4388-7e84-a501-3b02668d715b";
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_settled",
        type: "onramp",
        provider: "bvnk",
        // The payout reference names the same payout the stored receipt is
        // scoped to, so the receipt and the transfer facts agree.
        providerReference: payoutId,
        signature: hash,
        settlement: {
          provider: "bvnk",
          status: "COMPLETE",
          payinId,
          payoutId,
          receiptUrl: `https://pay.sandbox.bvnk.com/payout/${payoutId}`,
          fiatCurrency: "USD",
          fiatAmount: "9.9",
          cryptoCurrency: "USDC",
          cryptoAmount: "9.8802",
          feeCurrency: "USD",
          feeAmount: "0.1",
          networkFeeCurrency: "USD",
          networkFeeAmount: "0",
          exchangeRate: "0.998",
          txHash: hash,
          cryptoAmountActual: "9.8802",
          fiatAmountActual: "9.9",
          feeAmountActual: "0.1",
          feeCurrencyActual: "USD",
          networkFeeAmountActual: "0",
          networkFeeCurrencyActual: "USD",
          exchangeRateActual: "0.998",
        },
      }),
      { cluster: "devnet" },
      (key) => key
    );

    expect(rows.map(({ key, value }) => [key, value])).toEqual([
      ["DashboardPayments.transferDetails.status", "DashboardPayments.bvnk.settlementCompleted"],
      [
        "DashboardPayments.transferDetails.receipt",
        "DashboardPayments.transferDetails.viewReceipt",
      ],
      ["DashboardPayments.transferDetails.fiatSent", "9.90 USD"],
      ["DashboardPayments.transferDetails.cryptoToReceive", "9.8802 USDC"],
      ["DashboardPayments.transferDetails.providerFee", "0.10 USD"],
      ["DashboardPayments.transferDetails.exchangeRate", "1 USD = 0.998 USDC"],
      ["DashboardPayments.transferDetails.payinId", payinId],
      ["DashboardPayments.transferDetails.solanaSignature", "5XGAib…iwcM"],
    ]);
    expect(
      rows.find((row) => row.key === "DashboardPayments.transferDetails.receipt")
    ).toMatchObject({
      href: `https://pay.sandbox.bvnk.com/payout/${payoutId}`,
    });
    expect(
      rows.find((row) => row.key === "DashboardPayments.transferDetails.payinId")
    ).toMatchObject({ copyValue: payinId });
    expect(
      rows.find((row) => row.key === "DashboardPayments.transferDetails.payinId")
    ).not.toHaveProperty("mono");
    expect(
      rows.find((row) => row.key === "DashboardPayments.transferDetails.solanaSignature")
    ).toMatchObject({
      href: `https://explorer.solana.com/tx/${hash}?cluster=devnet`,
      copyValue: hash,
    });
    expect(
      rows.find((row) => row.key === "DashboardPayments.transferDetails.solanaSignature")
    ).not.toHaveProperty("mono");
  });

  it("builds BVNK PROCESSING rows without a tx hash and with the sandbox receipt url", () => {
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_processing",
        status: "settling",
        type: "onramp",
        provider: "bvnk",
        providerReference: "01a0ab3c-4388-7e84-a501-3b02668d715b",
        settlement: {
          provider: "bvnk",
          status: "PROCESSING",
          payinId: "01a0ab3c-2c02-7788-ab94-d5ce3bbb5db9",
          payoutId: "01a0ab3c-4388-7e84-a501-3b02668d715b",
          receiptUrl: "https://pay.sandbox.bvnk.com/payout/01a0ab3c-4388-7e84-a501-3b02668d715b",
          fiatCurrency: "USD",
          fiatAmount: "9.9",
          cryptoCurrency: "USDC",
          cryptoAmount: "9.8802",
          feeCurrency: "USD",
          feeAmount: "0.1",
          networkFeeCurrency: "USD",
          networkFeeAmount: "0.12",
          exchangeRate: "0.998",
        },
      }),
      { cluster: "mainnet-beta" },
      (key) => key
    );

    expect(rows.map(({ key, value }) => [key, value])).toEqual([
      ["DashboardPayments.transferDetails.status", "DashboardPayments.bvnk.settlementProcessing"],
      [
        "DashboardPayments.transferDetails.receipt",
        "DashboardPayments.transferDetails.viewReceipt",
      ],
      ["DashboardPayments.transferDetails.fiatSent", "9.90 USD"],
      ["DashboardPayments.transferDetails.cryptoToReceive", "9.8802 USDC"],
      ["DashboardPayments.transferDetails.providerFee", "0.10 USD"],
      ["DashboardPayments.transferDetails.networkFee", "0.12 USD"],
      ["DashboardPayments.transferDetails.exchangeRate", "1 USD = 0.998 USDC"],
      ["DashboardPayments.transferDetails.payinId", "01a0ab3c-2c02-7788-ab94-d5ce3bbb5db9"],
    ]);
    expect(rows[1]).toMatchObject({
      href: "https://pay.sandbox.bvnk.com/payout/01a0ab3c-4388-7e84-a501-3b02668d715b",
    });
    expect(rows.map(({ key }) => key)).not.toContain(
      "DashboardPayments.transferDetails.solanaSignature"
    );
  });

  it("renders no BVNK settlement rows for a failed-after-issued transfer", () => {
    // The payout was issued (the PROCESSING settlement blob was recorded at
    // issue) and then failed at the provider: the terminal status hides the
    // issued-payout economics, so the complete expected row set is empty.
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_failed_after_issued",
        status: "failed",
        type: "onramp",
        provider: "bvnk",
        providerReference: "01a0ab3c-4388-7e84-a501-3b02668d715b",
        settlement: {
          provider: "bvnk",
          status: "PROCESSING",
          payinId: "01a0ab3c-2c02-7788-ab94-d5ce3bbb5db9",
          payoutId: "01a0ab3c-4388-7e84-a501-3b02668d715b",
          receiptUrl: "https://pay.sandbox.bvnk.com/payout/01a0ab3c-4388-7e84-a501-3b02668d715b",
          fiatCurrency: "USD",
          fiatAmount: "9.9",
          cryptoCurrency: "USDC",
          cryptoAmount: "9.8802",
          feeCurrency: "USD",
          feeAmount: "0.1",
          networkFeeCurrency: "USD",
          networkFeeAmount: "0.12",
          exchangeRate: "0.998",
        },
      }),
      { cluster: "devnet" },
      (key) => key
    );

    expect(rows).toEqual([]);
  });

  it("renders no BVNK settlement rows for a canceled-before-payin transfer", () => {
    // Canceled while awaiting funding: no payout was ever issued, so no
    // settlement blob exists to render.
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_canceled_before_payin",
        status: "canceled",
        type: "onramp",
        provider: "bvnk",
      }),
      { cluster: "devnet" },
      (key) => key
    );

    expect(rows).toEqual([]);
  });

  describe("isValidBvnkReceiptUrl", () => {
    const payoutId = "01a0ab3c-4388-7e84-a501-3b02668d715b";

    it("accepts an https payout url on either BVNK host", () => {
      expect(isValidBvnkReceiptUrl(`https://pay.bvnk.com/payout/${payoutId}`, payoutId)).toBe(true);
      expect(
        isValidBvnkReceiptUrl(`https://pay.sandbox.bvnk.com/payout/${payoutId}`, payoutId)
      ).toBe(true);

      // The rejection matrix: wrong scheme, lookalike host, foreign host,
      // embedded credentials, non-default port, mismatched payout id,
      // extra path segments, and non-URLs are all refused.
      const rejects = [
        `http://pay.bvnk.com/payout/${payoutId}`,
        `https://pay.bvnk.com.evil.example/payout/${payoutId}`,
        `https://evil.example.com/payout/${payoutId}`,
        `https://user:pass@pay.bvnk.com/payout/${payoutId}`,
        `https://pay.bvnk.com:8443/payout/${payoutId}`,
        `https://pay.bvnk.com/payout/01a0ab3c-0000-0000-0000-000000000000`,
        `https://pay.bvnk.com/payout/${payoutId}/extra`,
        "not a url",
      ];
      for (const url of rejects) {
        expect(isValidBvnkReceiptUrl(url, payoutId)).toBe(false);
      }
    });
  });
});
