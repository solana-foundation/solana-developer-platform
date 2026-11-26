// @vitest-environment jsdom
import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen } from "@testing-library/react";
import { type State, SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { FreshSWRCache } from "@/test/swr";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { custodyQueryKeys } from "./custody-query-key";
import { fetchWalletBalances } from "./wallet-balances.data";
import { WalletCardBalanceValue } from "./wallet-card-balance-value";

const WALLET_ID = "wallet-1";
const BATCH_KEY = custodyQueryKeys.walletCardBalances();
const FALLBACK_KEY = custodyQueryKeys.walletCardBalanceFallback({ walletId: WALLET_ID });
const USDC = WELL_KNOWN_TOKENS.USDC;
const SHARED_READ_PATH = "/api/dashboard/wallets?includeBalances=true&view=summary";

/** A devnet USDC holding: the API prices nothing off mainnet, so the card values it by its mint. */
function usdcBalance(uiAmount: number) {
  return {
    token: USDC.symbol,
    mint: requiredWellKnownMint("USDC", "devnet"),
    amount: String(uiAmount * 1_000_000),
    uiAmount: String(uiAmount),
    decimals: USDC.mints.devnet.decimals,
  } satisfies CustodyWalletTokenBalance;
}

/** The card's balance over what the SWR cache already holds, with no read run again. */
function renderBalance(cached: [string, State<unknown, unknown>][]): string {
  const { container } = render(
    <EnglishI18n>
      <SWRConfig value={{ provider: () => new Map(cached), revalidateOnMount: false }}>
        <WalletCardBalanceValue walletId={WALLET_ID} initialBalances={[usdcBalance(1)]} />
      </SWRConfig>
    </EnglishI18n>
  );
  return container.innerHTML;
}

beforeEach(() => {
  setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/wallets`);
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("fetchWalletBalances", () => {
  it("keeps a known empty wallet and leaves out a wallet whose balances are unavailable", async () => {
    const fetchMock = stubDashboardFetch(() =>
      dashboardDataResponse(200, {
        wallets: [{ walletId: WALLET_ID }, { walletId: "empty-wallet", balances: [] }],
      })
    );

    expect(await fetchWalletBalances()).toEqual({ "empty-wallet": [] });
    expect(sentDashboardRequests(fetchMock).map((request) => request.path)).toEqual([
      SHARED_READ_PATH,
    ]);
  });
});

describe("WalletCardBalanceValue", () => {
  it("shows the shared read's balance without reading the wallet's own while the shared read holds it", async () => {
    const fetchMock = stubDashboardFetch(() =>
      dashboardDataResponse(200, {
        wallets: [{ walletId: WALLET_ID, balances: [usdcBalance(12)] }],
      })
    );

    render(
      <EnglishI18n>
        <FreshSWRCache>
          <WalletCardBalanceValue walletId={WALLET_ID} initialBalances={[usdcBalance(1)]} />
        </FreshSWRCache>
      </EnglishI18n>
    );

    expect((await screen.findByText("$12.00")).textContent).toBe("$12.00");
    expect(sentDashboardRequests(fetchMock).map((request) => request.path)).toEqual([
      SHARED_READ_PATH,
    ]);
  });

  it("shows this wallet's own balance when the shared read leaves it out", () => {
    const markup = renderBalance([
      [BATCH_KEY, { data: { "other-wallet": [] } }],
      [FALLBACK_KEY, { data: [usdcBalance(10)] }],
    ]);

    expect(markup).toContain("$10.00");
  });

  it("shows this wallet's own balance when the shared read fails", () => {
    const markup = renderBalance([
      [BATCH_KEY, { error: new Error("batch unavailable") }],
      [FALLBACK_KEY, { data: [usdcBalance(10)] }],
    ]);

    expect(markup).toContain("$10.00");
    expect(markup).not.toContain("(stale)");
  });

  it("marks the last known balance stale when both reads fail", () => {
    const markup = renderBalance([
      [
        BATCH_KEY,
        { data: { [WALLET_ID]: [usdcBalance(3)] }, error: new Error("batch unavailable") },
      ],
      [FALLBACK_KEY, { error: new Error("wallet unavailable") }],
    ]);

    expect(markup).toContain("$3.00");
    expect(markup).toContain("(stale)");
  });
});
