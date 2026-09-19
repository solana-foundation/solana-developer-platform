// @vitest-environment jsdom

import type { BvnkRampSettlement, PaymentRampQuote, PaymentTransferSummary } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { RampCompleteScreen } from "./ramp-complete-screen";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: false, orgId: null, userId: null }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/payments",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const SIGNATURE =
  "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
const PAYIN_ID = "01a0ab3c-2c02-7788-ab94-d5ce3bbb5db9";
const PAYOUT_ID = "01a0ab3c-4388-7e84-a501-3b02668d715b";
const RECEIPT_URL = `https://pay.sandbox.bvnk.com/payout/${PAYOUT_ID}`;
const CUSTODY_WALLET_ID = "cwlt_bvnk";

const BVNK_QUOTE: PaymentRampQuote = {
  id: "quote_bvnk",
  provider: "bvnk",
  status: "pending",
  deliveryMode: "manual_instructions",
  paymentInstructions: [],
};

const PROCESSING_SETTLEMENT: BvnkRampSettlement = {
  provider: "bvnk",
  status: "PROCESSING",
  payinId: PAYIN_ID,
  payoutId: PAYOUT_ID,
  receiptUrl: RECEIPT_URL,
  fiatCurrency: "USD",
  fiatAmount: "9.9",
  cryptoCurrency: "USDC",
  cryptoAmount: "9.8802",
  feeCurrency: "USD",
  feeAmount: "0.1",
  networkFeeCurrency: "USD",
  networkFeeAmount: "0.12",
  exchangeRate: "0.998",
};

const COMPLETE_SETTLEMENT: BvnkRampSettlement = {
  ...PROCESSING_SETTLEMENT,
  status: "COMPLETE",
  txHash: SIGNATURE,
  cryptoAmountActual: "9.8802",
  fiatAmountActual: "9.9",
  feeAmountActual: "0.1",
  feeCurrencyActual: "USD",
  networkFeeAmountActual: "0",
  networkFeeCurrencyActual: "USD",
  exchangeRateActual: "0.998",
};

function transferFixture(
  status: PaymentTransferSummary["status"],
  settlement: BvnkRampSettlement,
  signature: string | null
): PaymentTransferSummary {
  return {
    id: "xfr_bvnk_screen",
    custodyWalletId: CUSTODY_WALLET_ID,
    providerWalletId: "provider-bvnk",
    status,
    signature,
    rampsMemo: {},
    type: "onramp",
    provider: "bvnk",
    providerReference: PAYOUT_ID,
    token: "USDC",
    amount: "9.8802",
    fiatCurrency: "USD",
    fiatAmount: "9.9",
    settlement,
    createdAt: "2026-09-19T01:00:00.000Z",
    updatedAt: "2026-09-19T02:00:00.000Z",
  };
}

function renderScreen(transfer: PaymentTransferSummary): string {
  return renderToStaticMarkup(
    <DashboardWorkspaceProvider
      scopeRefreshFallback={null}
      dashboardAccess={resolveDashboardAccess("org:admin")}
      flags={{
        assetProfiles: false,
        custody: true,
        dvp: false,
        earn: false,
        heliusRings: false,
        issuance: false,
        markets: false,
        payments: true,
        policies: false,
        privateChannels: false,
      }}
      serverDashboardCacheScope={{ orgId: "org-test", userId: "user-test" }}
      projects={[]}
      initialSelectedProjectId={null}
      shouldRepairInitialProjectCookie={false}
    >
      <I18nProvider locale="en" messages={getMessages("en")}>
        <RampCompleteScreen direction="onramp" quote={BVNK_QUOTE} transfer={transfer} />
      </I18nProvider>
    </DashboardWorkspaceProvider>
  );
}

describe("RampCompleteScreen — BVNK onramp projections", () => {
  it("renders the PROCESSING projection without completion artifacts", () => {
    const markup = renderScreen(transferFixture("settling", PROCESSING_SETTLEMENT, null));

    // Processing status is shown while the payout is still in flight.
    expect(markup).toContain("Processing at BVNK");
    expect(markup).not.toContain("Completed");

    // The payout reference and the SDP transfer id are copyable rows.
    expect(markup).toContain("Provider Transfer ID");
    expect(markup).toContain(PAYOUT_ID);
    expect(markup).toContain('aria-label="Copy Provider Transfer ID"');
    expect(markup).toContain('aria-label="Copy SDP Transfer ID"');

    // The destination custody wallet is linked; the receipt is placed last.
    expect(markup).toContain("Destination");
    expect(markup).toContain(`href="/dashboard/wallets/${CUSTODY_WALLET_ID}"`);
    expect(markup).toContain(`href="${RECEIPT_URL}"`);
    expect(markup).toContain("View receipt");
    expect(markup.indexOf("View receipt")).toBeGreaterThan(markup.indexOf("Pay-in ID"));

    // Copyable pay-in id row, and no signature rows of any kind yet.
    expect(markup).toContain('aria-label="Copy Pay-in ID"');
    expect(markup).not.toContain("Onchain transaction");
    expect(markup).not.toContain("Onchain signature");
    expect(markup).not.toContain(SIGNATURE);

    // Funding economics are still rendered from the transfer projection.
    expect(markup).toContain("9.8802 USDC");
    expect(markup).toContain("funded with");
    expect(markup).toContain("9.9 USD");
  });

  it("renders the COMPLETE projection with the signature, timestamp, and receipt", () => {
    const markup = renderScreen(transferFixture("completed", COMPLETE_SETTLEMENT, SIGNATURE));

    // The status row and the completion timestamp both read "Completed" — the
    // timestamp only exists once the transfer is COMPLETE.
    expect(markup).not.toContain("Processing at BVNK");
    expect(markup.match(/Completed/g)).toHaveLength(2);

    // The settlement signature row and the transfer signature row both link
    // into the explorer, and both are copyable.
    expect(markup).toContain("Onchain signature");
    expect(markup).toContain("Onchain transaction");
    expect(markup).toContain(`href="https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet"`);
    expect(markup).toContain('aria-label="Copy Onchain signature"');
    expect(markup).toContain('aria-label="Copy Onchain transaction"');

    // The receipt is placed after the completion artifacts.
    expect(markup).toContain(`href="${RECEIPT_URL}"`);
    expect(markup.indexOf("View receipt")).toBeGreaterThan(markup.indexOf("Onchain transaction"));
    expect(markup.indexOf("View receipt")).toBeGreaterThan(markup.indexOf("Pay-in ID"));
  });
});
