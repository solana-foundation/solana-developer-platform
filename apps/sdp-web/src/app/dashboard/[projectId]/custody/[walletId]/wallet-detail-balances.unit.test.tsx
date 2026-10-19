import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockUseSWR } = vi.hoisted(() => ({ mockUseSWR: vi.fn() }));

vi.mock("swr", () => ({ default: mockUseSWR }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import { BALANCE_REFRESH_INTERVAL_MS } from "@/app/dashboard/[projectId]/custody/wallet-balances.data";
import {
  READ_AT,
  solBalance,
  trackedBalances,
} from "@/app/dashboard/[projectId]/custody/wallet-balances.fixtures";
import { formatDisplayAmount } from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { WalletBalanceRows, WalletBalanceTotal } from "./wallet-detail-balances";

function renderBalanceView(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

afterEach(() => {
  mockUseSWR.mockReset();
});

describe("wallet detail balances", () => {
  it("keeps the initial error and empty-wallet display when no poll has succeeded", () => {
    mockUseSWR.mockReturnValue({ data: undefined, error: new Error("RPC unavailable") });

    const rows = renderBalanceView(
      <WalletBalanceRows
        walletId="wallet-1"
        initial={trackedBalances([], "Balances unavailable")}
        tokenRoutes={{}}
        issuanceEnabled={false}
        emptyLabel="No balances"
      />
    );

    expect(rows).toContain("Balances unavailable");
    expect(rows).toContain("No balances");
  });

  it("keeps previously loaded token rows after a poll fails", () => {
    const cached = solBalance("2");
    mockUseSWR.mockReturnValue({ data: [cached], error: new Error("RPC unavailable") });

    const rows = renderBalanceView(
      <WalletBalanceRows
        walletId="wallet-1"
        initial={trackedBalances([cached], null)}
        tokenRoutes={{}}
        issuanceEnabled={false}
        emptyLabel="No balances"
      />
    );

    expect(rows).not.toContain("Unavailable");
    expect(rows).not.toContain("No balances");
    expect(rows).toContain(cached.mint);
  });
  it("shows the empty-wallet label only after a successful empty read", () => {
    mockUseSWR.mockReturnValue({ data: [] });

    const rows = renderBalanceView(
      <WalletBalanceRows
        walletId="wallet-1"
        initial={trackedBalances([solBalance("2")], null)}
        tokenRoutes={{}}
        issuanceEnabled={false}
        emptyLabel="No balances"
      />
    );

    expect(rows).toContain("No balances");
    expect(rows).not.toContain("Unavailable");
  });

  it("restores token rows when a successful read follows an unavailable read", () => {
    const balance = solBalance("2");
    const view = (
      <WalletBalanceRows
        walletId="wallet-1"
        initial={trackedBalances([], "Balances unavailable")}
        tokenRoutes={{}}
        issuanceEnabled={false}
        emptyLabel="No balances"
      />
    );
    mockUseSWR.mockReturnValue({ data: undefined });
    expect(renderBalanceView(view)).toContain("Balances unavailable");

    mockUseSWR.mockReturnValue({ data: [balance] });
    const recovered = renderBalanceView(view);
    expect(recovered).toContain(balance.mint);
    expect(recovered).not.toContain("Balances unavailable");
    expect(recovered).not.toContain("No balances");
  });

  it("polls the wallet's balances on the same cadence as the overview cards", () => {
    const balance = { ...solBalance("1"), usdValue: 150 };
    mockUseSWR.mockReturnValue({ data: undefined });

    renderBalanceView(
      <WalletBalanceTotal walletId="wallet-1" initial={trackedBalances([balance], null)} />
    );

    expect(mockUseSWR).toHaveBeenCalledWith(
      ["wallet-balances", "wallet-1", READ_AT],
      expect.any(Function),
      expect.objectContaining({
        fallbackData: [balance],
        refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
        revalidateOnFocus: true,
        revalidateOnMount: false,
      })
    );
  });

  it("shows polled balances instead of the server-rendered ones", () => {
    const initial = trackedBalances([{ ...solBalance("1"), usdValue: 150 }], null);
    mockUseSWR.mockReturnValue({ data: [{ ...solBalance("2"), usdValue: 300 }] });

    const total = renderBalanceView(<WalletBalanceTotal walletId="wallet-1" initial={initial} />);
    const rows = renderBalanceView(
      <WalletBalanceRows
        walletId="wallet-1"
        initial={initial}
        tokenRoutes={{}}
        issuanceEnabled={false}
        emptyLabel="No balances"
      />
    );

    expect(total).toContain("300");
    expect(total).not.toContain("150");
    expect(rows).toContain(formatDisplayAmount("2", "SOL"));
  });

  it("replaces a failed server read once a poll succeeds", () => {
    const initial = trackedBalances([], "Balances unavailable");

    mockUseSWR.mockReturnValue({ data: undefined });
    expect(
      renderBalanceView(<WalletBalanceTotal walletId="wallet-1" initial={initial} />)
    ).toContain("Balances unavailable");
    expect(mockUseSWR.mock.calls[0]?.[2]).toMatchObject({ revalidateOnMount: true });

    mockUseSWR.mockReturnValue({ data: [{ ...solBalance("1"), usdValue: 150 }] });
    const recovered = renderBalanceView(
      <WalletBalanceTotal walletId="wallet-1" initial={initial} />
    );
    expect(recovered).not.toContain("Balances unavailable");
    expect(recovered).toContain("150");
  });
  it("keeps the cached total when a poll fails", () => {
    mockUseSWR.mockReturnValue({
      data: [{ ...solBalance("1"), usdValue: 150 }],
      error: new Error("Unavailable"),
    });
    const total = renderBalanceView(
      <WalletBalanceTotal
        walletId="wallet-1"
        initial={trackedBalances([{ ...solBalance("1"), usdValue: 150 }], null)}
      />
    );
    expect(total).toContain("150");
    expect(total).not.toContain("Unavailable");
  });
});
