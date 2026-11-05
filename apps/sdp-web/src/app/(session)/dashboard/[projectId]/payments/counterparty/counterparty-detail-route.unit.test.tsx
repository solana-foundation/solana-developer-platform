// @vitest-environment jsdom

import type { Counterparty } from "@sdp/types/counterparties";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { CounterpartyDetailRoute } from "./counterparty-detail-workspace";

vi.mock("@/contexts/dashboard-workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/dashboard-workspace-context")>()),
  useCanWrite: () => true,
}));
vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/components/dashboard-page-title", () => ({ DashboardPageTitle: () => null }));
vi.mock("@/components/dashboard-workspace-panel", () => ({
  DashboardWorkspaceOverviewPanel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./add-external-account-dialog", () => ({ AddExternalAccountDialog: () => null }));
vi.mock("./delete-counterparty-dialog", () => ({ DeleteCounterpartyDialog: () => null }));

const CONTACT_PATH = "/api/dashboard/counterparty/cpty_test";

const counterparty: Counterparty = {
  id: "cpty_test",
  organizationId: "org_test",
  projectId: "prj_test_sandbox",
  externalId: null,
  entityType: "individual",
  displayName: "Test contact",
  status: "active",
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function payout(id: string) {
  return {
    id,
    custodyWalletId: null,
    providerWalletId: "pw_test",
    status: "completed",
    signature: null,
    direction: "outbound",
    token: "USDC",
    amount: "1",
    rampsMemo: {},
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

/** The contact with no addresses or payments, and `payoutsTotal` payouts in pages of 100. */
function serveContact(contactStatus: number, payoutsTotal: number, failedPage: number | null) {
  return stubDashboardFetch(({ path }) => {
    if (path === CONTACT_PATH) {
      return contactStatus === 200
        ? Response.json({ data: { counterparty } })
        : Response.json({ error: { message: "refused" } }, { status: contactStatus });
    }
    if (path.startsWith(`${CONTACT_PATH}/accounts?`)) {
      return Response.json({ data: { accounts: [], total: 0, page: 1, pageSize: 100 } });
    }
    const query = new URL(path, "https://dashboard.test").searchParams;
    if (query.get("direction") !== "outbound") return Response.json({ data: [] });
    const pageNumber = Number(query.get("page"));
    if (pageNumber === failedPage) {
      return Response.json({ error: { message: "unavailable" } }, { status: 503 });
    }
    const start = (pageNumber - 1) * 100;
    const count = Math.max(0, Math.min(100, payoutsTotal - start));
    return Response.json({
      data: Array.from({ length: count }, (_, index) => payout(`xfr_${start + index}`)),
      meta: { total: payoutsTotal },
    });
  });
}

function renderRoute() {
  render(
    <DashboardReadsProvider>
      <CounterpartyDetailRoute counterpartyId="cpty_test" rampsEnabled={false} />
    </DashboardReadsProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CounterpartyDetailRoute", () => {
  it("shows the Project's not-found page for a contact the API does not hold", async () => {
    serveContact(404, 0, null);
    renderRoute();

    expect(await screen.findByText("NotFound.backToOverview")).toBeTruthy();
  });

  it("reads settled payouts page by page up to the cap, under the tab's Project", async () => {
    const fetchMock = serveContact(200, 900, null);
    renderRoute();
    await screen.findByText("DashboardPayments.counterparty.detail.addresses");

    const payoutReads = sentDashboardReads(fetchMock).filter((read) =>
      read.path.includes("direction=outbound")
    );
    expect(
      payoutReads.map((read) =>
        new URL(read.path, "https://dashboard.test").searchParams.get("page")
      )
    ).toEqual(["1", "2", "3", "4", "5"]);
    expect(new Set(payoutReads.map((read) => read.projectId))).toEqual(
      new Set(["prj_test_sandbox"])
    );
  });

  it("says the payouts did not all load when a later page fails", async () => {
    serveContact(200, 250, 2);
    renderRoute();

    expect(
      await screen.findByText("DashboardPayments.counterparty.detail.paymentsNotLoaded")
    ).toBeTruthy();
  });
});
