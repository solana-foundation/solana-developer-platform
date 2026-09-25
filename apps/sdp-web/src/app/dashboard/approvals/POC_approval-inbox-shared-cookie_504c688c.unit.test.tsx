// @vitest-environment jsdom

import type { WalletApprovalRequestSummary } from "@sdp/types";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ApprovalInbox } from "./approval-inbox";

/**
 * @title Regression: Approval Inbox Binds Refreshes to the Mounted Project
 * @notice Security regression for SOLA9-558 (APE-876). The reported proof
 * showed that an ApprovalInbox rendered for Project A replaces its rows with
 * Project B data once a sibling tab switches the shared
 * `sdp_selected_project_id` cookie and the five-second auto-refresh runs,
 * because the client bound neither its refresh requests nor its rendered
 * state to the project it mounted with.
 *
 * These tests assert the secure invariant instead of the exploit:
 * 1. Every refresh request names the mounted project explicitly
 *    (`x-project-id`), so the proxy never answers from the ambient cookie.
 * 2. A cookie that a sibling tab switches to Project B cannot repaint a
 *    Project A inbox.
 * 3. A response whose rows carry another project's id is dropped whole, so an
 *    older proxy deploy that still resolved the shared cookie cannot mix
 *    projects into a mounted inbox either.
 *
 * The fetch stub models the dashboard proxy's project resolution: a request
 * carrying an explicit `x-project-id` binding is honored over the ambient
 * cookie exactly when `honorBinding` is set, mirroring the fixed proxy and,
 * with the binding ignored, a pre-fix proxy deployment.
 */

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const sharedProjectCookie = { value: "project-a" };

function approvalRequest(projectId: "project-a" | "project-b"): WalletApprovalRequestSummary {
  const suffix = projectId === "project-a" ? "A" : "B";
  return {
    id: `apr_${projectId}`,
    organizationId: "org_shared",
    projectId,
    walletOperationId: `operation_${projectId}`,
    approvalGroupId: null,
    status: "pending",
    provider: "privy",
    providerReference: null,
    requestedBy: "user_requester",
    resolvedBy: null,
    expiresAt: null,
    resolvedAt: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    wallet: {
      custodyWalletId: `custody_${projectId}`,
      walletId: `wallet_${projectId}`,
      publicKey: `Wallet${suffix}111111111111111111111111111111111`,
      label: `Project ${suffix} Treasury`,
    },
    operation: {
      id: `operation_${projectId}`,
      custodyWalletId: `custody_${projectId}`,
      walletId: `wallet_${projectId}`,
      apiKeyId: `key_${projectId}`,
      source: "payments",
      operationFamily: "transfer",
      operationType: "payment_transfer_execute",
      asset: USDC_MINT,
      amount: "42",
      destination: `Destination${suffix}11111111111111111111111111111`,
      status: "pending_approval",
      executionStartedAt: null,
      executionCompletedAt: null,
      executionError: null,
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    },
    policyEvaluation: {
      id: `evaluation_${projectId}`,
      decision: "approval_required",
      reasonCode: "amount_limit",
      reason: `Project ${suffix} policy requires approval`,
      matchedRules: [{ ruleId: `project-${suffix.toLowerCase()}-rule` }],
      requiresApproval: true,
      evaluatedAt: "2026-09-24T00:00:00.000Z",
    },
    viewerIsRequester: false,
    viewerCanDecide: true,
  };
}

function jsonResponse(requests: WalletApprovalRequestSummary[]) {
  return new Response(JSON.stringify({ data: { approvalRequests: requests } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderInbox() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApprovalInbox
        projectId="project-a"
        initialRequests={[approvalRequest("project-a")]}
        apiKeyNames={{}}
        issuedTokensByMint={{}}
        canDecide
        renderedAt={Date.now()}
      />
    </I18nProvider>
  );
}

function stubApprovalFetch(options: { honorBinding: boolean }) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const header = new Headers(init?.headers).get("x-project-id");
    const projectId = options.honorBinding && header ? header : sharedProjectCookie.value;
    return jsonResponse([approvalRequest(projectId as "project-a" | "project-b")]);
  });
}

function bindingHeadersOf(fetchMock: ReturnType<typeof stubApprovalFetch>): Array<string | null> {
  return fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-project-id"));
}

describe("ApprovalInbox mounted-project binding (SOLA9-558)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sharedProjectCookie.value = "project-a";
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps Project A rows after a sibling tab switches the shared cookie to Project B", async () => {
    const fetchMock = stubApprovalFetch({ honorBinding: true });
    vi.stubGlobal("fetch", fetchMock);

    renderInbox();
    expect(screen.getAllByText("Project A Treasury").length).toBeGreaterThan(0);

    // A sibling tab's selectProjectAction rewrites the shared cookie while
    // this inbox stays mounted on Project A.
    sharedProjectCookie.value = "project-b";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getAllByText("Project A Treasury").length).toBeGreaterThan(0);
    expect(screen.queryByText("Project B Treasury")).toBeNull();
    expect(screen.queryByText("Project B policy requires approval")).toBeNull();

    // Every refresh asked for the mounted project, never the ambient cookie.
    const refreshBindings = bindingHeadersOf(fetchMock);
    expect(refreshBindings.length).toBeGreaterThan(0);
    expect(refreshBindings.every((binding) => binding === "project-a")).toBe(true);
  });

  it("keeps Project A data when the project cookie remains Project A", async () => {
    vi.stubGlobal("fetch", stubApprovalFetch({ honorBinding: true }));

    renderInbox();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getAllByText("Project A Treasury").length).toBeGreaterThan(0);
    expect(screen.queryByText("Project B Treasury")).toBeNull();
  });

  it("drops a refresh answered for another project when the proxy ignores the binding", async () => {
    // A proxy that predates the explicit binding resolves the shared cookie,
    // so after the sibling tab's switch it answers with Project B rows. The
    // inbox must drop them whole rather than repaint Project A with them.
    vi.stubGlobal("fetch", stubApprovalFetch({ honorBinding: false }));

    renderInbox();
    expect(screen.getAllByText("Project A Treasury").length).toBeGreaterThan(0);

    sharedProjectCookie.value = "project-b";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getAllByText("Project A Treasury").length).toBeGreaterThan(0);
    expect(screen.queryByText("Project B Treasury")).toBeNull();
    expect(screen.queryByText("Project B policy requires approval")).toBeNull();
  });
});
