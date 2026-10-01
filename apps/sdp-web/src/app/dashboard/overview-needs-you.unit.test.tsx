// @vitest-environment jsdom

import type { WalletApprovalRequestSummary } from "@sdp/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("@/lib/dashboard-swr", async () => {
  const { default: useSWR } = await import("swr");
  return {
    usePersistedDashboardSWR: (key: string, fetcher: () => Promise<unknown>) =>
      useSWR(key, fetcher),
  };
});

const { OverviewNeedsYou } = await import("./overview-needs-you");

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function request(
  id: string,
  overrides: Partial<WalletApprovalRequestSummary> & {
    operation?: Partial<WalletApprovalRequestSummary["operation"]>;
  } = {}
): WalletApprovalRequestSummary {
  const { operation, ...rest } = overrides;
  return {
    id,
    organizationId: "org_test",
    projectId: "prj_test",
    walletOperationId: `op_${id}`,
    approvalGroupId: null,
    status: "pending",
    provider: null,
    providerReference: null,
    requestedBy: "user_other",
    resolvedBy: null,
    expiresAt: null,
    resolvedAt: null,
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    wallet: { custodyWalletId: "cw_1", walletId: "w_1", publicKey: "pk_1", label: "Treasury" },
    operation: {
      id: `op_${id}`,
      custodyWalletId: "cw_1",
      walletId: "w_1",
      apiKeyId: null,
      source: "api",
      operationFamily: "transfer",
      operationType: "transfer_sol",
      asset: "SOL",
      amount: "2",
      destination: null,
      status: "pending_approval",
      executionStartedAt: null,
      executionCompletedAt: null,
      executionError: null,
      createdAt: "2026-09-25T10:00:00.000Z",
      updatedAt: "2026-09-25T10:00:00.000Z",
      ...operation,
    } as WalletApprovalRequestSummary["operation"],
    policyEvaluation: null,
    viewerIsRequester: false,
    viewerCanDecide: true,
    ...rest,
  };
}

function respond(requests: WalletApprovalRequestSummary[] | null, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 503,
      json: async () => ({ data: { approvalRequests: requests ?? undefined } }),
    }))
  );
}

function renderNeedsYou() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <OverviewNeedsYou />
      </I18nProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OverviewNeedsYou", () => {
  it("lists the requests this viewer can decide, the longest wait first", async () => {
    respond([
      request("appr_newest", { createdAt: "2026-09-25T11:00:00.000Z" }),
      request("appr_own", { viewerCanDecide: false, viewerIsRequester: true }),
      request("appr_oldest", {
        createdAt: "2026-09-25T08:00:00.000Z",
        wallet: null,
        operation: { walletId: "wallet_without_a_label_0001", asset: MINT, amount: "15000" },
        policyEvaluation: {
          id: "pe_1",
          decision: "require_approval",
          reasonCode: "amount_over_limit",
          reason: null,
          matchedRules: [],
          requiresApproval: true,
          evaluatedAt: "2026-09-25T08:00:00.000Z",
        } as WalletApprovalRequestSummary["policyEvaluation"],
      }),
    ]);
    renderNeedsYou();

    expect(await screen.findByText("2 waiting on you")).toBeTruthy();
    const links = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.includes("appr_"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard/approvals/appr_oldest",
      "/dashboard/approvals/appr_newest",
    ]);
    expect(links[0]?.textContent).toContain("Transfer Sol from wallet...l_0001");
    expect(links[0]?.textContent).toContain("Amount Over Limit");
    expect(links[0]?.textContent).toContain("15,000.00 EPjFWd…Dt1v");
    expect(links[1]?.textContent).toContain("Transfer Sol from Treasury");
    expect(links[1]?.textContent).toContain("Approval required");
    expect(links[1]?.textContent).toContain("2.00 SOL");
    expect(screen.getByRole("link", { name: "All approvals" }).getAttribute("href")).toBe(
      "/dashboard/approvals"
    );
  });

  it("shows at most four rows and leaves a request with no amount unpriced", async () => {
    respond([
      request("appr_1", { operation: { amount: null } }),
      request("appr_2", { operation: { amount: "not-a-number", asset: null } }),
      request("appr_3"),
      request("appr_4"),
      request("appr_5"),
    ]);
    renderNeedsYou();

    expect(await screen.findByText("5 waiting on you")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("not-a-number")).toBeTruthy();
  });

  it("renders nothing when nothing waits on the viewer", async () => {
    respond([request("appr_own", { viewerCanDecide: false })]);
    const { container } = renderNeedsYou();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on a failed read", async () => {
    respond(null, false);
    const { container } = renderNeedsYou();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
