import type { CustodyWalletTokenBalance } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockUseSWR } = vi.hoisted(() => ({ mockUseSWR: vi.fn() }));

vi.mock("swr", () => ({ default: mockUseSWR }));

import { BALANCE_REFRESH_INTERVAL_MS } from "@/app/dashboard/custody/wallet-balances.data";
import { WalletBalanceRows, WalletBalanceTotal } from "./wallet-detail-balances";

const WALLET_ID = "wallet-1";

function sol(uiAmount: string, usdValue: number): CustodyWalletTokenBalance {
  return {
    token: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    amount: String(Number(uiAmount) * 1_000_000_000),
    uiAmount,
    decimals: 9,
    usdValue,
  };
}

afterEach(() => {
  mockUseSWR.mockReset();
});

describe("wallet detail balances", () => {
  it("polls the wallet's balances on the same cadence as the overview cards", () => {
    mockUseSWR.mockReturnValue({ data: undefined });

    renderToStaticMarkup(
      <WalletBalanceTotal
        walletId={WALLET_ID}
        initial={{ balances: [sol("1", 150)], error: null }}
      />
    );

    expect(mockUseSWR).toHaveBeenCalledWith(
      ["wallet-balances", WALLET_ID],
      expect.any(Function),
      expect.objectContaining({
        fallbackData: [sol("1", 150)],
        refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
        revalidateOnFocus: true,
        // A cached balance from an earlier visit must not outlive the fresh server read.
        revalidateOnMount: true,
      })
    );
  });

  it("shows polled balances instead of the server-rendered ones", () => {
    const initial = { balances: [sol("1", 150)], error: null };
    mockUseSWR.mockReturnValue({ data: [sol("2", 300)] });

    const total = renderToStaticMarkup(
      <WalletBalanceTotal walletId={WALLET_ID} initial={initial} />
    );
    const rows = renderToStaticMarkup(
      <WalletBalanceRows
        walletId={WALLET_ID}
        initial={initial}
        tokenRoutes={{}}
        issuanceEnabled={false}
        emptyLabel="No balances"
      />
    );

    expect(total).toContain("300");
    expect(total).not.toContain("150");
    expect(rows).toContain("2");
  });

  it("replaces a failed server read once a poll succeeds", () => {
    const initial = { balances: [], error: "Balances unavailable" };

    mockUseSWR.mockReturnValue({ data: undefined });
    expect(
      renderToStaticMarkup(<WalletBalanceTotal walletId={WALLET_ID} initial={initial} />)
    ).toContain("Balances unavailable");
    expect(mockUseSWR.mock.calls[0]?.[2]).toMatchObject({ revalidateOnMount: true });

    mockUseSWR.mockReturnValue({ data: [sol("1", 150)] });
    const recovered = renderToStaticMarkup(
      <WalletBalanceTotal walletId={WALLET_ID} initial={initial} />
    );
    expect(recovered).not.toContain("Balances unavailable");
    expect(recovered).toContain("150");
  });
});
