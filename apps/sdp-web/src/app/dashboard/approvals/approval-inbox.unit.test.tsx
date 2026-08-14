import type { WalletApprovalRequestSummary } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ApprovalInbox } from "./approval-inbox";

function renderInbox(overrides: Partial<Parameters<typeof ApprovalInbox>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApprovalInbox
        initialRequests={[]}
        apiKeyNames={{}}
        issuedTokensByMint={{}}
        canDecide
        renderedAt={0}
        {...overrides}
      />
    </I18nProvider>
  );
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ISSUED_MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function pendingRequest(
  operation: Partial<WalletApprovalRequestSummary["operation"]>
): WalletApprovalRequestSummary {
  return {
    id: "apr_1",
    organizationId: "org_1",
    projectId: null,
    walletOperationId: "wop_1",
    approvalGroupId: null,
    status: "pending",
    provider: null,
    providerReference: null,
    requestedBy: null,
    resolvedBy: null,
    expiresAt: null,
    resolvedAt: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    wallet: null,
    operation: {
      id: "wop_1",
      custodyWalletId: null,
      walletId: "wal_1",
      apiKeyId: null,
      source: "api",
      operationFamily: "transfer",
      operationType: "transfer.spl",
      asset: null,
      amount: null,
      destination: null,
      status: "pending_approval",
      executionStartedAt: null,
      executionCompletedAt: null,
      executionError: null,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      ...operation,
    },
    policyEvaluation: null,
  };
}

describe("ApprovalInbox filters", () => {
  it("renders the date presets with every catalog key resolved (regression: missing translation)", () => {
    // Rendering exercises DateRangeFilter, which throws if any dateX key is absent;
    // the closed select only shows the active preset in the trigger.
    const markup = renderInbox();
    expect(markup).toContain("All time");
  });

  it("defaults the date range to All time with no date fields shown", () => {
    const markup = renderInbox();
    // All time is the active preset by default; custom From/To inputs stay hidden.
    expect(markup).toContain('aria-label="Date"');
    expect(markup).not.toContain('type="date"');
  });

  it("shows the wallet, operation, and API-key filters on the pending tab", () => {
    const markup = renderInbox();
    expect(markup).toContain("All wallets");
    expect(markup).toContain("All operations");
    expect(markup).toContain("All API keys");
  });
});

describe("ApprovalInbox amount/asset column", () => {
  it("resolves a well-known mint to its symbol instead of printing the raw mint", () => {
    const markup = renderInbox({
      initialRequests: [pendingRequest({ asset: USDC_MINT, amount: "12.5" })],
    });
    expect(markup).toContain("12.50 USDC");
    expect(markup).toContain("/token-logos/usdc.svg");
  });

  it("wears the registry logo when the asset is a platform token key, not a mint", () => {
    const markup = renderInbox({
      initialRequests: [pendingRequest({ asset: "USDC", amount: "150" })],
    });
    expect(markup).toContain("150 USDC");
    expect(markup).toContain("/token-logos/usdc.svg");
    // The raw mint may only appear inside the hover title, never as cell text.
    expect(markup).not.toContain(`>${USDC_MINT}`);
  });

  it("resolves an SDP-issued mint through the issued-token map", () => {
    const markup = renderInbox({
      initialRequests: [pendingRequest({ asset: ISSUED_MINT, amount: "3" })],
      issuedTokensByMint: {
        [ISSUED_MINT]: { id: "tok_1", mintAddress: ISSUED_MINT, symbol: "ACME", imageUrl: null },
      },
    });
    expect(markup).toContain("3.00 ACME");
    expect(markup).not.toContain(`>${ISSUED_MINT}`);
  });

  it("falls back to a shortened mint that cannot wrap when the asset is unknown", () => {
    const markup = renderInbox({
      initialRequests: [pendingRequest({ asset: ISSUED_MINT, amount: "3" })],
    });
    expect(markup).toContain(`3.00 ${ISSUED_MINT.slice(0, 6)}…${ISSUED_MINT.slice(-4)}`);
    expect(markup).not.toContain(`>${ISSUED_MINT}`);
  });
});
