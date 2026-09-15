import type { WalletApprovalRequestSummary } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ApprovalInbox } from "./approval-inbox";

const urlTab = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/lib/dashboard-url-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-url-state")>()),
  useDashboardTab: () => urlTab.value,
}));

afterEach(() => {
  urlTab.value = null;
});

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
      operationType: "payment_transfer_execute",
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
    viewerIsRequester: false,
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

describe("ApprovalInbox history status", () => {
  function approvedRequest(
    id: string,
    operation: Partial<WalletApprovalRequestSummary["operation"]>
  ): WalletApprovalRequestSummary {
    const base = pendingRequest(operation);
    return {
      ...base,
      id,
      status: "approved",
      resolvedAt: "2026-08-14T01:00:00.000Z",
      operation: { ...base.operation, id: `wop_${id}` },
    };
  }

  // An approval whose execution failed did not do what was approved, so its
  // row must not wear the same green badge as one that ran.
  it("badges an approved request whose execution failed apart from one that executed", () => {
    urlTab.value = "history";
    const markup = renderInbox({
      initialRequests: [
        approvedRequest("ran", { status: "completed" }),
        approvedRequest("broke", {
          status: "failed",
          executionError: "Provider quote/session reference has expired; create a new quote.",
        }),
      ],
    });

    // Each request renders once in the mobile list and once in the table.
    expect(markup.match(/>Execution failed</g)).toHaveLength(2);
    expect(markup.match(/>Approved</g)).toHaveLength(2);
  });
});
