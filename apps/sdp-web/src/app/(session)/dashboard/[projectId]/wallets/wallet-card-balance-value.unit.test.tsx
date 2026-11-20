import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { renderToStaticMarkup } from "react-dom/server";
import { type State, SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dashboardDataResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { custodyQueryKeys } from "./custody-query-key";
import { fetchWalletBalances } from "./wallet-balances.data";
import { WalletCardBalanceValue } from "./wallet-card-balance-value";

const WALLET_ID = "wallet-1";
const BATCH_KEY = custodyQueryKeys.walletCardBalances();
const FALLBACK_KEY = custodyQueryKeys.walletCardBalanceFallback({ walletId: WALLET_ID });
const USDC = WELL_KNOWN_TOKENS.USDC;

function usdcBalance(usdValue: number): CustodyWalletTokenBalance {
  return {
    token: USDC.symbol,
    mint: USDC.mints.devnet.address,
    amount: String(usdValue * 1_000_000),
    uiAmount: String(usdValue),
    decimals: USDC.mints.devnet.decimals,
    usdValue,
  };
}

/** The card's balance as the server renders it over what the SWR cache already holds. */
function renderBalance(cached: [string, State<unknown, unknown>][]): string {
  return renderToStaticMarkup(
    <EnglishI18n>
      <SWRConfig value={{ provider: () => new Map(cached) }}>
        <WalletCardBalanceValue walletId={WALLET_ID} initialBalances={[usdcBalance(1)]} />
      </SWRConfig>
    </EnglishI18n>
  );
}

beforeEach(() => {
  setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/wallets`);
});

afterEach(() => {
  restoreWindowLocation();
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
      "/api/dashboard/wallets?includeBalances=true&view=summary",
    ]);
  });
});

describe("WalletCardBalanceValue", () => {
  it("shows the shared read's balance and ignores the per-wallet fallback while it holds the wallet", () => {
    const markup = renderBalance([
      [BATCH_KEY, { data: { [WALLET_ID]: [usdcBalance(12)] } }],
      [FALLBACK_KEY, { data: [usdcBalance(99)] }],
    ]);

    expect(markup).toContain("$12.00");
    expect(markup).not.toContain("$99.00");
    expect(markup).not.toContain("(stale)");
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
