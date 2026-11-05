// @vitest-environment jsdom

import type { Counterparty } from "@sdp/types/counterparties";
import type { PaymentRecurringPayment } from "@sdp/types/payments";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { stubMatchMedia } from "@/test/media-queries";
import type { RecurringPaymentsListState } from "./recurring-payments.data";
import { RecurringPaymentsWorkspace } from "./recurring-payments-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const schedule: PaymentRecurringPayment = {
  id: "prp_test",
  organizationId: "org_test",
  projectId: "prj_test_sandbox",
  sourceCustodyWalletId: "cwlt_test",
  sourceProviderWalletId: "pw_test",
  sourceAddress: "11111111111111111111111111111111",
  counterpartyId: "cpty_test",
  counterpartyAccountId: "cpa_test",
  destinationAddress: "11111111111111111111111111111111",
  destinationTokenAccount: null,
  token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "1",
  periodHours: 24,
  firstCollectionAt: null,
  nextCollectionDueAt: null,
  planId: null,
  subscriptionId: null,
  planPda: null,
  planCreatedAt: null,
  planCreationSignature: null,
  subscriptionPda: null,
  subscriptionAuthorityAddress: null,
  authorizationSignature: null,
  status: "active",
  pausedReason: null,
  metadataUri: null,
  createdBy: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};
const contact: Counterparty = {
  id: "cpty_found",
  organizationId: "org_test",
  projectId: "prj_test_sandbox",
  externalId: null,
  entityType: "business",
  displayName: "Northwind",
  status: "active",
  createdBy: null,
  createdAt: schedule.createdAt,
  updatedAt: schedule.updatedAt,
};

function serveSchedules(rows: readonly PaymentRecurringPayment[], total: number) {
  return stubDashboardFetch(({ path }) => {
    if (path.startsWith("/api/dashboard/payments/recurring-payments?")) {
      return Response.json({ data: { recurringPayments: rows, total, page: 1, pageSize: 25 } });
    }
    if (path.startsWith("/api/dashboard/wallets")) return Response.json({ data: { wallets: [] } });
    if (path === `/api/dashboard/counterparty/${contact.id}`) {
      return Response.json({ data: { counterparty: contact } });
    }
    const status = path === "/api/dashboard/counterparty/cpty_archived" ? 404 : 503;
    return Response.json({ error: { message: "refused" } }, { status });
  });
}

async function renderWorkspace(
  listState: RecurringPaymentsListState,
  rows: readonly PaymentRecurringPayment[],
  total: number
) {
  const fetchMock = serveSchedules(rows, total);
  render(
    <EnglishI18n>
      <DashboardReadsProvider>
        <RecurringPaymentsWorkspace listState={listState} issuanceEnabled={false} />
      </DashboardReadsProvider>
    </EnglishI18n>
  );
  await waitFor(() =>
    expect(document.querySelector('[data-loading-layout="recurring-payments"]')).toBeNull()
  );
  return fetchMock;
}

beforeEach(() => {
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetDashboardNavigation();
  window.history.replaceState(null, "", "/");
});

describe("RecurringPaymentsWorkspace contacts", () => {
  it("reads each contact a page names once, labelling an archived one and flagging a failed one", async () => {
    const rows = ["cpty_found", "cpty_archived", "cpty_found", "cpty_failed"].map(
      (counterpartyId, index) => ({ ...schedule, id: `prp_${index}`, counterpartyId })
    );
    const fetchMock = await renderWorkspace({ page: 1, pageSize: 25, status: null }, rows, 4);

    expect(await screen.findByText("Some contact names could not be loaded.")).toBeTruthy();
    expect(screen.getAllByText(/to Northwind$/)).toHaveLength(2);
    expect(screen.getAllByText(/to Archived counterparty$/)).toHaveLength(1);
    expect(
      sentDashboardReads(fetchMock)
        .map((read) => read.path)
        .filter((path) => path.startsWith("/api/dashboard/counterparty/"))
        .sort()
    ).toEqual([
      "/api/dashboard/counterparty/cpty_archived",
      "/api/dashboard/counterparty/cpty_failed",
      "/api/dashboard/counterparty/cpty_found",
    ]);
  });

  it("says a name is loading until its read settles, keeping the names read for the last page", async () => {
    const otherContact = Promise.withResolvers<Response>();
    stubDashboardFetch(({ path }) => {
      if (path.startsWith("/api/dashboard/payments/recurring-payments?")) {
        const pageTwo = path.includes("page=2");
        const ids = pageTwo ? ["cpty_found", "cpty_other"] : ["cpty_found"];
        return Response.json({
          data: {
            recurringPayments: ids.map((counterpartyId) => ({
              ...schedule,
              id: `prp_${counterpartyId}`,
              counterpartyId,
            })),
            total: 30,
            page: pageTwo ? 2 : 1,
            pageSize: 25,
          },
        });
      }
      if (path.startsWith("/api/dashboard/wallets"))
        return Response.json({ data: { wallets: [] } });
      return path === "/api/dashboard/counterparty/cpty_other"
        ? otherContact.promise
        : Response.json({ data: { counterparty: contact } });
    });
    const page = (pageNumber: number) => (
      <EnglishI18n>
        <DashboardReadsProvider>
          <RecurringPaymentsWorkspace
            listState={{ page: pageNumber, pageSize: 25, status: null }}
            issuanceEnabled={false}
          />
        </DashboardReadsProvider>
      </EnglishI18n>
    );
    const view = render(page(1));
    expect(await screen.findByText(/to Northwind$/)).toBeTruthy();

    view.rerender(page(2));

    expect(await screen.findByText(/to Loading…$/)).toBeTruthy();
    expect(screen.getByText(/to Northwind$/)).toBeTruthy();
    expect(screen.queryByText(/to Counterparty unavailable$/)).toBeNull();
    otherContact.resolve(Response.json({ error: { message: "unavailable" } }, { status: 503 }));
    expect(await screen.findByText(/to Counterparty unavailable$/)).toBeTruthy();
    expect(screen.queryByText(/to Loading…$/)).toBeNull();
  });
});

describe("RecurringPaymentsWorkspace pagination", () => {
  it("shows no pager when every schedule fits on the first page", async () => {
    await renderWorkspace({ page: 1, pageSize: 25, status: null }, [], 10);

    expect(screen.queryByRole("button", { name: "Previous page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("keeps the pager on a saved page past the end, its back arrow landing on the first page", async () => {
    window.history.replaceState(null, "", "/dashboard/payments/recurring?page=3&status=active");
    await renderWorkspace({ page: 3, pageSize: 25, status: "active" }, [], 10);

    expect(screen.getByText("Page 3 of 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));

    expect(dashboardRouter.replace).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/payments/recurring?status=active",
      { scroll: false }
    );
  });

  it("sends the back arrow past the end to the last page there is", async () => {
    window.history.replaceState(null, "", "/dashboard/payments/recurring?page=7");
    await renderWorkspace({ page: 7, pageSize: 25, status: null }, [], 60);

    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));

    expect(dashboardRouter.replace).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/payments/recurring?page=3",
      { scroll: false }
    );
  });

  it("counts the rows a page in range shows", async () => {
    await renderWorkspace({ page: 2, pageSize: 25, status: null }, [], 60);

    expect(screen.getByText("26-50 of 60 schedules")).toBeTruthy();
  });
});
