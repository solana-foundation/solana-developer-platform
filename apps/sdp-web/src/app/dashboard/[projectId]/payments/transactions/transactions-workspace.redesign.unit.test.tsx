// @vitest-environment jsdom

import { UNIFIED_TRANSACTION_MODULES, type UnifiedTransactionModule } from "@sdp/types";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { TransactionFilters } from "./transactions-query.redesign";
import { TransactionsWorkspace } from "./transactions-workspace.redesign";

// jsdom implements no matchMedia, while the workspace's motion components read
// it through useReducedMotion.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ projectId: "prj_test_sandbox" }),
  usePathname: () => "/dashboard/prj_test_sandbox/payments/transactions",
}));

// The real menu is a Radix dropdown; render its sections flat so a test can read the options (labels
// stay out of the text, so the chips are the only text match).
vi.mock("@/components/ui/filter-menu", () => ({
  FilterMenu: ({ sections }: { sections: { id: string; content: ReactNode }[] }) => (
    <div>
      {sections.map((section) => (
        <div key={section.id} data-filter-section={section.id}>
          {section.content}
        </div>
      ))}
    </div>
  ),
  FilterMenuOptions: ({ options }: { options: { value: string; label: string }[] }) => (
    <>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-filter-option={option.value}
          aria-label={option.label}
        />
      ))}
    </>
  ),
}));

function renderWorkspace(
  filters: TransactionFilters,
  modules: readonly UnifiedTransactionModule[] = UNIFIED_TRANSACTION_MODULES
) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <TransactionsWorkspace
          initialFilters={filters}
          initialResult={{ transactions: [], nextCursor: null }}
          issuedTokensByMint={{}}
          wallets={[{ id: "cwlt_1", label: "Treasury", publicKey: "Pub111" }]}
          counterparties={[{ id: "cpty_42", name: "Acme Treasury" }]}
          modules={modules}
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

  it("offers only the modules the channel leaves on in the Type filter", () => {
    const { container } = renderWorkspace({ cursors: [] }, ["payments"]);

    const types = [
      ...container.querySelectorAll('[data-filter-section="type"] [data-filter-option]'),
    ].map((option) => option.getAttribute("data-filter-option")?.split(":")[0]);
    expect(new Set(types)).toEqual(new Set(["payments"]));
  });

  it("writes a new page size and restarts on the first page", () => {
    renderWorkspace({ cursors: ["a"], cursor: "b" });
    expect(screen.getByRole("combobox", { name: "Rows per page" })).toBeDefined();
  });
});
