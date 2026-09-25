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
 * 1. A bound empty refresh applies: the request named the mounted project
 *    explicitly and the proxy's `x-sdp-project-id` echo proves the empty
 *    answer is bound to it, so two empty batches mean the project genuinely
 *    has no requests — stale rows must clear, and the refresh must not read
 *    as a load failure.
 * 2. An echoless empty pair (an older proxy build still resolving the shared
 *    selection cookie) establishes nothing: the mounted rows stand instead of
 *    being erased, without reading as a load failure.
 * 3. A project switch re-binds the inbox to the new scope's page props, so a
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

function emptyBatchResponse(scope?: string) {
  return Response.json(
    { data: { approvalRequests: [] } },
    { status: 200, headers: scope ? { "x-sdp-project-id": scope } : undefined }
  );
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

  it("clears the mounted rows when a bound refresh answers an emptied project", async () => {
    // Fresh Response per call: a body can only be read once, and the pending
    // and recent fetches run in parallel. The echo names the mounted project,
    // so the current proxy build proves the empty answer is bound to it.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => emptyBatchResponse("project-a"))
    );

    renderInbox();
    expect(screen.getAllByText("Treasury").length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // The bound empty answer applied, resolving the stale pending row…
    expect(screen.queryByText("Treasury")).toBeNull();
    expect(screen.getByText("No requests are waiting for approval")).toBeTruthy();
    // …and the refresh did not read as a failure either.
    expect(screen.queryByText("Unable to load approval requests")).toBeNull();
  });

  it("applies a refresh whose pending batch is empty but whose recent batch has rows", async () => {
    // A project with approval history but nothing pending: the pending query
    // legitimately answers empty while the recent query returns rows, so the
    // pair is in scope and must apply rather than fail the refresh. The
    // empty half carries the proxy's echo; the rows prove the other half.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("status=pending")) return emptyBatchResponse("project-a");
        return Response.json({
          data: { approvalRequests: [{ ...approvalRequest("project-a"), id: "apr_new" }] },
        });
      })
    );

    renderInbox();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith("/dashboard/approvals/"));
    expect(hrefs).toContain("/dashboard/approvals/apr_new");
    expect(hrefs).not.toContain("/dashboard/approvals/apr_project-a");
    expect(screen.queryByText("Unable to load approval requests")).toBeNull();
  });

  it("stays on the empty state without a load error when the project has no requests", async () => {
    // An echoless empty pair (an older proxy build) establishes nothing, so
    // the refresh neither repaints nor reads as a failure: an empty inbox
    // simply stays empty.
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

  it("keeps the mounted rows when an older proxy answers empty without the echo", async () => {
    // A rolling deploy: an older proxy build still resolves the shared
    // selection cookie, and a sibling tab has switched it to an empty
    // project. The echoless empty pair proves nothing about the mounted
    // project, so its rows must stand — not be erased by the empty answer —
    // and the refresh must not read as a failure either.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => emptyBatchResponse())
    );

    renderInbox();
    expect(screen.getAllByText("Treasury").length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getAllByText("Treasury").length).toBeGreaterThan(0);
    expect(screen.queryByText("Unable to load approval requests")).toBeNull();
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
