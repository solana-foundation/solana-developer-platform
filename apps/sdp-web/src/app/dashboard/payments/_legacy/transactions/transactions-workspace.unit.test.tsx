// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { TransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

const replace = vi.fn();
const urlState = vi.hoisted(() => ({ tab: null as string | null }));

vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardTab: () => urlState.tab,
  readDashboardTabFromUrl: () => urlState.tab,
  replaceDashboardSearchParams: (updates: Record<string, string | null>) => replace(updates),
}));
vi.mock("@/lib/dashboard-fetch", () => ({
  dashboardFetch: async () => ({
    ok: true,
    data: { data: { transactions: [], nextCursor: null } },
    status: 200,
  }),
}));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));

function renderWorkspace(filters: TransactionFilters) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <TransactionsWorkspace
          initialFilters={filters}
          initialResult={{ transactions: [], nextCursor: null }}
          issuedTokensByMint={{}}
        />
      </I18nProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  replace.mockReset();
  urlState.tab = null;
});
afterEach(cleanup);

describe("TransactionsWorkspace", () => {
  it("adopts the shared tab's module when the URL carries one the loaded filters lack", () => {
    urlState.tab = "earn";

    renderWorkspace({ cursors: [] });

    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ tab: "earn", kind: null }));
  });

  it("commits a search only once it has three characters", () => {
    renderWorkspace({ cursors: [] });
    const search = screen.getByLabelText("Search transactions");

    fireEvent.change(search, { target: { value: "xf" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(replace).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: "xfr_" } });
    act(() => {
      fireEvent.keyDown(search, { key: "Enter" });
    });
    expect(replace).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "xfr_", cursor: null, cursors: null })
    );
  });

  it("shows the module's kinds inside a module tab", () => {
    urlState.tab = "earn";
    renderWorkspace({ module: "earn", cursors: [] });

    expect(screen.getByLabelText("Transaction kind")).toBeDefined();
  });

  it("shows and dismisses a linked counterparty filter", () => {
    renderWorkspace({ counterpartyId: "cpty_42", cursors: [] });

    expect(screen.getByText("cpty_42").closest("a")?.getAttribute("href")).toBe(
      "/dashboard/payments/counterparty/cpty_42"
    );
    act(() => fireEvent.click(screen.getByLabelText("Clear counterparty filter")));
    expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ counterpartyId: null }));
  });

  it("shows and dismisses a linked token filter", () => {
    renderWorkspace({ token: "Mint111", cursors: [] });

    expect(screen.getByText("Mint111")).toBeDefined();
    act(() => fireEvent.click(screen.getByLabelText("Clear token filter")));
    expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ token: null }));
  });
});
