import type { PaymentRampQuote, PaymentTransferSummary } from "@sdp/types/payments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolveTransferFlow } from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { providerTransferDetailRows } from "@/app/dashboard/[projectId]/payments/provider-transfer-details";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { RampCompleteScreen } from "./ramp-complete-screen";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));

const DEVNET_USDC = requiredWellKnownMint("USDC", "devnet");
const DELIVERY =
  "5Zegs7mguCgwDJxUb5YeGeJG7tvTQ6mRfSwakahuySsScMDERzvqbXv8DfbJEnXMmwQF33LtLzRjm9vUncCZqMos";

const QUOTE: PaymentRampQuote = {
  provider: "moonpay",
  id: "xfr_receipt",
  status: "pending",
  deliveryMode: "hosted",
  hostedUrl: "https://sell-sandbox.moonpay.com",
};

function sale(overrides: Partial<PaymentTransferSummary> = {}): PaymentTransferSummary {
  return {
    id: "xfr_receipt",
    custodyWalletId: "cwlt_receipt",
    providerWalletId: "wallet_receipt",
    status: "completed",
    signature: DELIVERY,
    rampsMemo: {},
    type: "offramp",
    provider: "moonpay",
    token: DEVNET_USDC,
    amount: "25",
    fiatCurrency: "USD",
    fiatAmount: "20.69",
    fiatPayout: { amount: "20.82", currency: "USD" },
    createdAt: "2026-10-19T23:01:00.000Z",
    updatedAt: "2026-10-19T23:09:00.000Z",
    confirmedAt: "2026-10-19T23:07:00.000Z",
    ...overrides,
  };
}

function renderReceipt(transfer: PaymentTransferSummary, direction: "onramp" | "offramp") {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RampCompleteScreen direction={direction} quote={QUOTE} transfer={transfer} />
    </I18nProvider>
  );
}

describe("RampCompleteScreen", () => {
  it("leads a completed sale with the payout and keeps the quote beside it", () => {
    const markup = renderReceipt(sale(), "offramp");

    expect(markup).toContain("20.82 USD");
    expect(markup).toContain("Quoted payout");
    expect(markup).toContain("20.69 USD");
    // The net payout over the crypto would misstate MoonPay's rate.
    expect(markup).not.toContain("Exchange rate");
  });

  it("dates completion from SDP's confirmation, not the last update", () => {
    const markup = renderReceipt(sale(), "offramp");
    const completed = renderReceipt(sale({ confirmedAt: undefined }), "offramp");

    expect(markup).not.toEqual(completed);
  });

  it("names a buy's delivery transaction once", () => {
    const markup = renderReceipt(
      sale({
        type: "onramp",
        amount: "0.5",
        fiatAmount: "20",
        fiatPayout: undefined,
        settlement: {
          provider: "moonpay",
          status: "completed",
          transactionId: "moonpay-buy",
          baseCurrencyCode: "USD",
          baseCurrencyAmount: 20,
          quoteCurrencyCode: "USDC",
          quoteCurrencyAmount: 0.5,
          feeAmount: 0.81,
          extraFeeAmount: 0,
          networkFeeAmount: 0,
          areFeesIncluded: false,
          usdRate: 1,
          cryptoTransactionId: DELIVERY,
        },
      }),
      "onramp"
    );

    expect(markup).toContain("Onchain transaction");
    expect(markup).not.toContain("Onchain signature");
  });
});

describe("a sale's reported payout", () => {
  const t = (key: string) => key;

  it("shows the quote only when the provider paid a different amount", () => {
    const keys = (transfer: PaymentTransferSummary) =>
      providerTransferDetailRows(transfer, { cluster: "devnet" }, t).map((row) => row.key);

    expect(keys(sale())).toContain("DashboardPayments.transferDetails.quotedPayout");
    expect(keys(sale({ fiatPayout: { amount: "20.69", currency: "USD" } }))).not.toContain(
      "DashboardPayments.transferDetails.quotedPayout"
    );
  });

  it("tells the contact what they got once the provider pays", () => {
    expect(resolveTransferFlow(sale()).receive).toBe("20.82 USD");
    expect(resolveTransferFlow(sale({ fiatPayout: undefined })).receive).toBe("20.69 USD");
  });
});
