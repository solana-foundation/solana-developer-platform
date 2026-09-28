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
      "TestDepos1tS1gnature11111111111111111111111111111111111111111111111111111111111111111111";
    const payinId = "00000000-0000-4000-8000-00000000b001";
    const payoutId = "00000000-0000-4000-8000-00000000b002";
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_settled",
        type: "onramp",
        provider: "bvnk",
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
      ["DashboardPayments.transferDetails.solanaSignature", "TestDe…1111"],
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
  it.each([
    {
      networkFeeAmount: "0.00001",
      networkFeeRows: [["DashboardPayments.transferDetails.networkFee", "0.00001 SOL"]],
    },
    { networkFeeAmount: "0", networkFeeRows: [] },
  ])(
    "builds BVNK off-ramp rows with network fee $networkFeeAmount",
    ({ networkFeeAmount, networkFeeRows }) => {
      const hash =
        "TestDepos1tS1gnature11111111111111111111111111111111111111111111111111111111111111111111";
      const rows = providerTransferDetailRows(
        transferFixture({
          id: "xfr_bvnk_offramp_settled",
          type: "offramp",
          provider: "bvnk",
          settlement: {
            provider: "bvnk",
            kind: "offramp_channel",
            status: "COMPLETE",
            channelId: "01000000-0000-7000-8000-00000000c002",
            transactionId: "01000000-0000-7000-8000-00000000c7a1",
            txHash: hash,
            depositAddress: "TestChanne1Depos1tAddress111111111111111111",
            cryptoCurrency: "USDC",
            cryptoAmount: "10",
            fiatCurrency: "USD",
            fiatAmount: "9.9",
            displayCurrency: "USD",
            displayAmount: "9.9",
            feeCurrency: "USD",
            feeAmount: "0.09",
            networkFeeCurrency: "SOL",
            networkFeeAmount,
            exchangeRate: "0.99",
            sources: ["src_a", "src_b"],
          },
        }),
        { cluster: "devnet" },
        (key) => key
      );
      expect(rows.map(({ key, value }) => [key, value])).toEqual([
        ["DashboardPayments.transferDetails.received", "10.00 USDC"],
        ["DashboardPayments.transferDetails.credited", "9.90 USD"],
        ["DashboardPayments.transferDetails.providerFee", "0.09 USD"],
        ...networkFeeRows,
        ["DashboardPayments.transferDetails.exchangeRate", "1 USDC = 0.99 USD"],
        ["DashboardPayments.transferDetails.depositTx", "TestDe…1111"],
      ]);
      expect(
        rows.find((row) => row.key === "DashboardPayments.transferDetails.depositTx")
      ).toMatchObject({
        href: `https://explorer.solana.com/tx/${hash}?cluster=devnet`,
        copyValue: hash,
      });
    }
  );

  it("omits BVNK off-ramp rows for a settlement of another kind", () => {
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_onramp_on_offramp_type",
        type: "offramp",
        provider: "bvnk",
        settlement: {
          provider: "bvnk",
          status: "PROCESSING",
          payinId: "payin_1",
          payoutId: "payout_1",
          receiptUrl: "https://pay.sandbox.bvnk.com/payout/payout_1",
          fiatCurrency: "USD",
          fiatAmount: "9.9",
          cryptoCurrency: "USDC",
          cryptoAmount: "9.8802",
          feeCurrency: "USD",
          feeAmount: "0.1",
          networkFeeCurrency: "USD",
          networkFeeAmount: "0",
          exchangeRate: "0.998",
        },
      }),
      { cluster: "devnet" },
      (key) => key
    );

    expect(rows).toEqual([]);
  });
  it("builds BVNK PROCESSING rows without a tx hash and with the sandbox receipt url", () => {
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_processing",
        status: "settling",
        type: "onramp",
        provider: "bvnk",
        providerReference: "00000000-0000-4000-8000-00000000b002",
        settlement: {
          provider: "bvnk",
          status: "PROCESSING",
          payinId: "00000000-0000-4000-8000-00000000b001",
          payoutId: "00000000-0000-4000-8000-00000000b002",
          receiptUrl: "https://pay.sandbox.bvnk.com/payout/00000000-0000-4000-8000-00000000b002",
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
      ["DashboardPayments.transferDetails.payinId", "00000000-0000-4000-8000-00000000b001"],
    ]);
    expect(rows[1]).toMatchObject({
      href: "https://pay.sandbox.bvnk.com/payout/00000000-0000-4000-8000-00000000b002",
    });
    expect(rows.map(({ key }) => key)).not.toContain(
      "DashboardPayments.transferDetails.solanaSignature"
    );
  });
  it("renders no BVNK settlement rows for a failed-after-issued transfer", () => {
    const rows = providerTransferDetailRows(
      transferFixture({
        id: "xfr_bvnk_failed_after_issued",
        status: "failed",
        type: "onramp",
        provider: "bvnk",
        providerReference: "00000000-0000-4000-8000-00000000b002",
        settlement: {
          provider: "bvnk",
          status: "PROCESSING",
          payinId: "00000000-0000-4000-8000-00000000b001",
          payoutId: "00000000-0000-4000-8000-00000000b002",
          receiptUrl: "https://pay.sandbox.bvnk.com/payout/00000000-0000-4000-8000-00000000b002",
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
    const payoutId = "00000000-0000-4000-8000-00000000b002";

    it("accepts an https payout url on either BVNK host", () => {
      expect(isValidBvnkReceiptUrl(`https://pay.bvnk.com/payout/${payoutId}`, payoutId)).toBe(true);
      expect(
        isValidBvnkReceiptUrl(`https://pay.sandbox.bvnk.com/payout/${payoutId}`, payoutId)
      ).toBe(true);

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
