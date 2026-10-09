// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  solBalance,
  trackedBalances,
} from "@/app/dashboard/[projectId]/custody/wallet-balances.fixtures";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import {
  WalletBalanceRows,
  WalletBalanceTotal,
  type WalletTrackedBalancesResult,
} from "./wallet-detail-balances";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const walletId = "cwlt_selected";
const balance = { ...solBalance("1"), usdValue: 150 };
const unavailable = "Tracked balances are unavailable right now.";

function RefreshBalances() {
  const { mutate } = useSWRConfig();
  return (
    <button type="button" onClick={() => void mutate(() => true)}>
      Refresh balances
    </button>
  );
}

function renderBalances(initial: WalletTrackedBalancesResult) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <RefreshBalances />
        <WalletBalanceTotal walletId={walletId} initial={initial} />
        <WalletBalanceRows
          walletId={walletId}
          initial={initial}
          tokenRoutes={{}}
          issuanceEnabled={false}
          emptyLabel="No assets"
        />
      </SWRConfig>
    </I18nProvider>
  );
}

beforeEach(() => {
  resetDashboardNavigation();
  setDashboardUrl(`/dashboard/prj_test_sandbox/wallets/${walletId}`, { walletId });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("wallet detail balances", () => {
  it.each([503, 404, "wrong wallet"] as const)(
    "shows unavailable rather than an old balance or empty wallet after a %s refresh",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          failure === "wrong wallet"
            ? Response.json({
                data: { walletBalances: { custodyWalletId: "cwlt_other", balances: [] } },
              })
            : Response.json({ error: { message: "Read failed" } }, { status: failure })
        )
      );
      const view = renderBalances(trackedBalances([balance], null));
      expect(view.getByText("$150.00")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Refresh balances" }));

      await waitFor(() => expect(view.getAllByText(unavailable)).toHaveLength(2));
      expect(view.getByText("—")).toBeTruthy();
      expect(view.queryByText("$150.00")).toBeNull();
      expect(view.queryByText("$0.00")).toBeNull();
      expect(view.queryByText("No assets")).toBeNull();
      expect(view.queryByText("1.00 SOL")).toBeNull();
    }
  );

  it("clears an initial server error once a refresh succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: { walletBalances: { custodyWalletId: walletId, balances: [balance] } },
        })
      )
    );
    const view = renderBalances(trackedBalances([], unavailable));

    await waitFor(() => expect(view.getByText("$150.00")).toBeTruthy());
    expect(view.queryByText(unavailable)).toBeNull();
    expect(view.queryByText("No assets")).toBeNull();
  });
});
