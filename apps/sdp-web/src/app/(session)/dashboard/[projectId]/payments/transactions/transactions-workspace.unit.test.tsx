// @vitest-environment jsdom

import {
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types/unified-transactions";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { stubMatchMedia } from "@/test/media-queries";
import { enabledPaymentTransactionKinds } from "./transaction-modules";
import type { TransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

const replace = vi.fn();

vi.mock("@/lib/dashboard-url-state", () => ({
  replaceDashboardSearchParams: (updates: Record<string, string | null>) => replace(updates),
}));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ projectId: "prj_test_sandbox" }),
  usePathname: () => "/dashboard/prj_test_sandbox/payments/transactions",
}));

// The real menu is a Radix dropdown; render its sections flat so a test can read the options (labels
// stay out of the text, so the chips are the only text match).
vi.mock("@sdp/ui/filter-menu", () => ({
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

const reads = { walletsFail: false };

function serveReads() {
  return stubDashboardFetch(({ path }) => {
    if (path.startsWith("/api/dashboard/wallets")) {
      return reads.walletsFail
        ? Response.json({ error: { message: "unavailable" } }, { status: 503 })
        : Response.json({
            data: {
              wallets: [
                {
                  id: "cwlt_1",
                  walletId: "wallet_1",
                  label: "Treasury",
                  publicKey: "Pub111",
                  custodyConfigId: "ccfg_test",
                  isRuntimeExecutionAllowed: true,
                },
              ],
            },
          });
    }
    if (path.startsWith("/api/dashboard/counterparty?")) {
      return Response.json({
        data: {
          counterparties: [{ id: "cpty_42", displayName: "Acme Treasury", entityType: "business" }],
          total: 1,
        },
      });
    }
    return Response.json({ data: { transactions: [], nextCursor: null } });
  });
}

function renderWorkspace(
  filters: TransactionFilters,
  modules: readonly UnifiedTransactionModule[]
) {
  const fetchMock = serveReads();
  const view = render(
    <EnglishI18n>
      <DashboardReadsProvider>
        <TransactionsWorkspace
          initialFilters={filters}
          issuanceEnabled={false}
          modules={modules}
          paymentKinds={enabledPaymentTransactionKinds({ ramps: true })}
        />
      </DashboardReadsProvider>
    </EnglishI18n>
  );
  return { ...view, fetchMock };
}

beforeEach(() => {
  replace.mockReset();
  reads.walletsFail = false;
  stubMatchMedia();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TransactionsWorkspace", () => {
  it("commits a search only once it has three characters", () => {
    renderWorkspace({ cursors: [] }, UNIFIED_TRANSACTION_MODULES);
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

  it("names an active contact filter and clears it from its chip", async () => {
    renderWorkspace({ counterpartyId: "cpty_42", cursors: [] }, UNIFIED_TRANSACTION_MODULES);

    expect(await screen.findByText("Acme Treasury")).toBeDefined();
    act(() => fireEvent.click(screen.getByLabelText("Clear Contact filter")));
    expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ counterpartyId: null }));
  });

  it("clears the module and kind together from the type chip", () => {
    renderWorkspace({ module: "earn", kind: "deposit", cursors: [] }, UNIFIED_TRANSACTION_MODULES);

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

  it("loads each filter's options on its own, and retries only the one that failed", async () => {
    reads.walletsFail = true;
    const { container, fetchMock } = renderWorkspace({ cursors: [] }, UNIFIED_TRANSACTION_MODULES);
    const section = (id: string) => {
      const element = container.querySelector<HTMLElement>(`[data-filter-section="${id}"]`);
      if (element === null) throw new Error(`no ${id} filter`);
      return within(element);
    };
    const contactReads = () =>
      sentDashboardReads(fetchMock).filter((read) =>
        read.path.startsWith("/api/dashboard/counterparty?")
      );

    expect(section("contact").getByText("Loading options…")).toBeDefined();
    expect(section("token").queryByText("Loading options…")).toBeNull();
    expect(await section("wallet").findByText("These options did not load.")).toBeDefined();
    await waitFor(() => expect(section("contact").getByLabelText("Acme Treasury")).toBeDefined());

    reads.walletsFail = false;
    act(() => fireEvent.click(section("wallet").getByRole("button", { name: "Retry" })));

    expect(await section("wallet").findByLabelText("Treasury")).toBeDefined();
    expect(contactReads()).toHaveLength(1);
  });

  it("writes a new page size and restarts on the first page", () => {
    renderWorkspace({ cursors: ["a"], cursor: "b" }, UNIFIED_TRANSACTION_MODULES);
    expect(screen.getByRole("combobox", { name: "Rows per page" })).toBeDefined();
  });
});
