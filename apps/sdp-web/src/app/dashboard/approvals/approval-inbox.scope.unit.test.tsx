// @vitest-environment jsdom

import type { WalletApprovalRequestSummary } from "@sdp/types";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ApprovalInbox } from "./approval-inbox";

/**
 * Regression coverage for the inbox's project-scoped refresh edges:
 *
 * 1. An empty refresh (both batches empty) establishes nothing about scope —
 *    an older proxy still resolving the shared selection cookie answers like
 *    that for a sibling tab's empty project — so it must never erase the
 *    mounted rows, and it must not read as a load failure for a project that
 *    genuinely has no requests.
 * 2. A project switch re-binds the inbox to the new scope's page props, so a
 *    new project whose initial load failed shows the error panel instead of
 *    an empty inbox hiding the failure.
 */

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function approvalRequest(projectId: string): WalletApprovalRequestSummary {
  return {
    id: `apr_${projectId}`,
    organizationId: "org_1",
    projectId,
    walletOperationId: `operation_${projectId}`,
    approvalGroupId: null,
    status: "pending",
    provider: "privy",
    providerReference: null,
    requestedBy: "user_1",
    resolvedBy: null,
    expiresAt: null,
    resolvedAt: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    wallet: {
      custodyWalletId: `custody_${projectId}`,
      walletId: `wallet_${projectId}`,
      publicKey: "WalletA11111111111111111111111111111111111",
      label: "Treasury",
    },
    operation: {
      id: `operation_${projectId}`,
      custodyWalletId: `custody_${projectId}`,
      walletId: `wallet_${projectId}`,
      apiKeyId: null,
      source: "payments",
      operationFamily: "transfer",
      operationType: "payment_transfer_execute",
      asset: USDC_MINT,
      amount: "42",
      destination: null,
      status: "pending_approval",
      executionStartedAt: null,
      executionCompletedAt: null,
      executionError: null,
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    },
    policyEvaluation: null,
    viewerIsRequester: false,
    viewerCanDecide: true,
  };
}

function emptyBatchResponse() {
  return Response.json({ data: { approvalRequests: [] } }, { status: 200 });
}

function renderInbox(props: Partial<Parameters<typeof ApprovalInbox>[0]> = {}) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApprovalInbox
        projectId="project-a"
        initialRequests={[approvalRequest("project-a")]}
        apiKeyNames={{}}
        issuedTokensByMint={{}}
        canDecide
        renderedAt={Date.now()}
        {...props}
      />
    </I18nProvider>
  );
}

describe("ApprovalInbox project-scoped refreshes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the mounted rows when an empty refresh answers for an empty project", async () => {
    // An older proxy still resolving the shared cookie can follow a sibling
    // tab's switch to a project with no approval requests: both batches come
    // back empty without a single row proving which project answered.
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(emptyBatchResponse()));

    renderInbox();
    expect(screen.getAllByText("Treasury").length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // The unconfirmed empty answer did not erase the mounted rows…
    expect(screen.getAllByText("Treasury").length).toBeGreaterThan(0);
    // …and the refresh did not read as a failure either.
    expect(screen.queryByText("Unable to load approval requests")).toBeNull();
  });

  it("stays on the empty state without a load error when the project has no requests", async () => {
    // Fresh Response per call: a body can only be read once, and the pending
    // and recent fetches run in parallel.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => emptyBatchResponse())
    );

    renderInbox({ initialRequests: [] });
    expect(screen.getByText("No requests are waiting for approval")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.queryByText("Unable to load approval requests")).toBeNull();
    expect(screen.getByText("No requests are waiting for approval")).toBeTruthy();
  });

  it("shows the new project's load error when a switch lands on a failed page load", async () => {
    const { rerender } = renderInbox();
    expect(screen.queryByText("Unable to load approval requests")).toBeNull();

    // The page's server render for the new project failed its initial load:
    // it hands the inbox empty rows and loadError, which the reset must keep.
    rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApprovalInbox
          projectId="project-b"
          initialRequests={[]}
          apiKeyNames={{}}
          issuedTokensByMint={{}}
          canDecide
          renderedAt={Date.now()}
          loadError
        />
      </I18nProvider>
    );

    expect(screen.getByText("Unable to load approval requests")).toBeTruthy();
    expect(screen.queryByText("Treasury")).toBeNull();
  });
});
