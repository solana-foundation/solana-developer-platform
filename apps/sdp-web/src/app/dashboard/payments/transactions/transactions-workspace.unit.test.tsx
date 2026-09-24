// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { TransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

const replace = vi.fn();

vi.mock("@/lib/dashboard-url-state", () => ({
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
          wallets={[{ id: "cwlt_1", label: "Treasury", publicKey: "Pub111" }]}
          counterparties={[{ id: "cpty_42", name: "Acme Treasury" }]}
        />
      </I18nProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  replace.mockReset();
});
afterEach(cleanup);

describe("TransactionsWorkspace", () => {
  it("commits a search only once it has three characters", () => {
    renderWorkspace({ cursors: [] });
    const search = screen.getByRole("searchbox", { name: "Search transactions" });

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

  it("names an active contact filter and clears it from its chip", () => {
    renderWorkspace({ counterpartyId: "cpty_42", cursors: [] });

    expect(screen.getByText("Acme Treasury")).toBeDefined();
    act(() => fireEvent.click(screen.getByLabelText("Clear Contact filter")));
    expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ counterpartyId: null }));
  });

  it("clears the module and kind together from the type chip", () => {
    renderWorkspace({ module: "earn", kind: "deposit", cursors: [] });

    expect(screen.getByText("Earn · Deposit")).toBeDefined();
    act(() => fireEvent.click(screen.getByLabelText("Clear Type filter")));
    expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ module: null, kind: null }));
  });

  it("writes a new page size and restarts on the first page", () => {
    renderWorkspace({ cursors: ["a"], cursor: "b" });
    expect(screen.getByRole("combobox", { name: "Rows per page" })).toBeDefined();
  });
});
