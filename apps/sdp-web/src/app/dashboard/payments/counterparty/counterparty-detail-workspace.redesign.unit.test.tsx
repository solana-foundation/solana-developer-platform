// @vitest-environment jsdom

import type { Counterparty } from "@sdp/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CounterpartyDetailWorkspace } from "./counterparty-detail-workspace.redesign";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/dashboard-page-title", () => ({ DashboardPageTitle: () => null }));
vi.mock("@/components/dashboard-workspace-panel", () => ({
  DashboardWorkspaceOverviewPanel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./add-external-account-dialog", () => ({ AddExternalAccountDialog: () => null }));
vi.mock("./delete-counterparty-dialog", () => ({ DeleteCounterpartyDialog: () => null }));

const counterparty: Counterparty = {
  id: "cpty_test",
  organizationId: "org_test",
  projectId: "prj_test",
  externalId: null,
  entityType: "individual",
  displayName: "Test contact",
  status: "active",
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("redesigned Contacts provider accounts", () => {
  it.each([false, true])("respects ramps visibility when enabled is %s", async (rampsEnabled) => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ data: { accounts: [] } })
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CounterpartyDetailWorkspace
          counterparty={counterparty}
          initialAccounts={[]}
          initialTransfers={[]}
          payouts={[]}
          rampsEnabled={rampsEnabled}
        />
      </SWRConfig>
    );

    const label = "DashboardPayments.counterparty.detail.providerAccounts";
    if (rampsEnabled) {
      expect(screen.getByText(label)).toBeTruthy();
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(fetch.mock.calls[0]?.[0]).toBe(
        "/api/dashboard/counterparty/cpty_test/provider-accounts"
      );
    } else {
      expect(screen.queryByText(label)).toBeNull();
      // Let SWR start any scheduled request before checking the excluded surface.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetch).not.toHaveBeenCalled();
    }
    expect(screen.getByText("DashboardPayments.counterparty.detail.addresses")).toBeTruthy();
  });
});
