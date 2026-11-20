// @vitest-environment jsdom

import {
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types/unified-transactions";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  dashboardDataResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { stubMatchMedia } from "@/test/media-queries";
import { FreshSWRCache } from "@/test/swr";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { enabledPaymentTransactionKinds } from "./transaction-modules";
import type { TransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));

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

const TRANSACTIONS_PATH = "/dashboard/prj_test_sandbox/payments/transactions";

let fetchMock: Mock<typeof fetch>;

/** Renders the workspace on the transactions page, its URL carrying `query`. */
function renderWorkspace(
  filters: TransactionFilters,
  modules: readonly UnifiedTransactionModule[],
  query = ""
) {
  setWindowPathname(`${TRANSACTIONS_PATH}${query}`);
  return render(
    <FreshSWRCache>
      <EnglishI18n>
        <TransactionsWorkspace
          initialFilters={filters}
          initialResult={{ transactions: [], nextCursor: null }}
          issuedTokensByMint={{}}
          wallets={[{ id: "cwlt_1", label: "Treasury", publicKey: "Pub111" }]}
          counterparties={[{ id: "cpty_42", name: "Acme Treasury" }]}
          modules={modules}
          paymentKinds={enabledPaymentTransactionKinds({ ramps: true })}
        />
      </EnglishI18n>
    </FreshSWRCache>
  );
}

async function expectListReads(paths: string[]) {
  await waitFor(() =>
    expect(sentDashboardRequests(fetchMock).map((request) => request.path)).toEqual(paths)
  );
}

beforeEach(() => {
  resetDashboardNavigation();
  stubMatchMedia();
  fetchMock = stubDashboardFetch(() =>
    dashboardDataResponse(200, { transactions: [], nextCursor: null })
  );
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("TransactionsWorkspace", () => {
  it("commits a search only once it has three characters, from the first page", async () => {
    renderWorkspace(
      { cursor: "b", cursors: ["a"] },
      UNIFIED_TRANSACTION_MODULES,
      "?cursor=b&cursors=a"
    );
    const search = screen.getByRole("searchbox", { name: "Search transactions" });

    fireEvent.change(search, { target: { value: "xf" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(window.location.search).toBe("?cursor=b&cursors=a");

    fireEvent.change(search, { target: { value: "xfr_" } });
    act(() => {
      fireEvent.keyDown(search, { key: "Enter" });
    });
    expect(window.location.search).toBe("?search=xfr_");
    await expectListReads(["/api/dashboard/payments/transactions?limit=25&search=xfr_"]);
  });

  it("names an active contact filter and clears it from its chip", async () => {
    renderWorkspace(
      { counterpartyId: "cpty_42", cursors: [] },
      UNIFIED_TRANSACTION_MODULES,
      "?counterpartyId=cpty_42"
    );

    expect(screen.getByText("Acme Treasury")).toBeDefined();
    act(() => fireEvent.click(screen.getByLabelText("Clear Contact filter")));
    expect(window.location.search).toBe("");
    await expectListReads(["/api/dashboard/payments/transactions?limit=25"]);
  });

  it("clears the module and kind together from the type chip", async () => {
    renderWorkspace(
      { module: "earn", kind: "deposit", cursors: [] },
      UNIFIED_TRANSACTION_MODULES,
      "?module=earn&kind=deposit"
    );

    expect(screen.getByText("Earn · Deposit")).toBeDefined();
    act(() => fireEvent.click(screen.getByLabelText("Clear Type filter")));
    expect(window.location.search).toBe("");
    await expectListReads(["/api/dashboard/payments/transactions?limit=25"]);
  });

  it("offers only the modules the channel leaves on in the Type filter", () => {
    const { container } = renderWorkspace({ cursors: [] }, ["payments"]);

    const types = [
      ...container.querySelectorAll('[data-filter-section="type"] [data-filter-option]'),
    ].map((option) => option.getAttribute("data-filter-option")?.split(":")[0]);
    expect(new Set(types)).toEqual(new Set(["payments"]));
  });
});
