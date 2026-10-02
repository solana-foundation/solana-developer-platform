import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockUseSWR } = vi.hoisted(() => ({ mockUseSWR: vi.fn() }));

vi.mock("swr", () => ({ default: mockUseSWR }));

import { BALANCE_REFRESH_INTERVAL_MS } from "@/app/dashboard/custody/wallet-balances.data";
import {
  READ_AT,
  solBalance,
  trackedBalances,
} from "@/app/dashboard/custody/wallet-balances.fixtures";
import { formatDisplayAmount } from "../../payments/payments-overview.utils";
import { WalletBalanceRows, WalletBalanceTotal } from "./wallet-detail-balances";

afterEach(() => {
  mockUseSWR.mockReset();
});

describe("wallet detail balances", () => {
  it("polls the wallet's balances on the same cadence as the overview cards", () => {
    const balance = { ...solBalance("1"), usdValue: 150 };
    mockUseSWR.mockReturnValue({ data: undefined });

    renderToStaticMarkup(
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

    const total = renderToStaticMarkup(
      <WalletBalanceTotal walletId="wallet-1" initial={initial} />
    );
    const rows = renderToStaticMarkup(
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
      renderToStaticMarkup(<WalletBalanceTotal walletId="wallet-1" initial={initial} />)
    ).toContain("Balances unavailable");
    expect(mockUseSWR.mock.calls[0]?.[2]).toMatchObject({ revalidateOnMount: true });

    mockUseSWR.mockReturnValue({ data: [{ ...solBalance("1"), usdValue: 150 }] });
    const recovered = renderToStaticMarkup(
      <WalletBalanceTotal walletId="wallet-1" initial={initial} />
    );
    expect(recovered).not.toContain("Balances unavailable");
    expect(recovered).toContain("150");
  });
});
