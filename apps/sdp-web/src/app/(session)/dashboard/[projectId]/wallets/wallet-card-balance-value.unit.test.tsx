import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { renderToStaticMarkup } from "react-dom/server";
import { type State, SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { custodyQueryKeys } from "./custody-query-key";
import { fetchWalletBalances } from "./wallet-balances.data";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

import { WalletCardBalanceValue } from "./wallet-card-balance-value";

const WALLET_ID = "wallet-1";
const BATCH_KEY = custodyQueryKeys.walletCardBalances();
const FALLBACK_KEY = custodyQueryKeys.walletCardBalanceFallback({ walletId: WALLET_ID });

function balance(usdValue: number): CustodyWalletTokenBalance {
  return {
    token: "USDC",
    mint: "mint-1",
    amount: String(usdValue * 1_000_000),
    uiAmount: String(usdValue),
    decimals: 6,
    usdValue,
  };
}

function renderBalance(cached: [string, State<unknown, unknown>][]) {
  const cache = new Map(cached);
  const cacheReads = vi.spyOn(cache, "get");
  const markup = renderToStaticMarkup(
    <SWRConfig value={{ provider: () => cache }}>
      <WalletCardBalanceValue walletId={WALLET_ID} initialBalances={[balance(1)]} />
    </SWRConfig>
  );
  return { markup, readKeys: cacheReads.mock.calls.map(([key]) => key) };
}

beforeEach(() => {
  setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/wallets`);
});

afterEach(() => {
  restoreWindowLocation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WalletCardBalanceValue", () => {
  it("excludes unavailable balances while preserving a known empty wallet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: { wallets: [{ walletId: WALLET_ID }, { walletId: "empty-wallet", balances: [] }] },
        })
      )
    );
    expect(await fetchWalletBalances()).toEqual({ "empty-wallet": [] });
  });

  it("recovers an omitted wallet through its own balance endpoint", () => {
    const { markup, readKeys } = renderBalance([
      [BATCH_KEY, { data: { "other-wallet": [] } }],
      [FALLBACK_KEY, { data: [balance(10)] }],
    ]);
    expect(markup).toContain("$10.00");
    expect(readKeys).toContain(FALLBACK_KEY);
  });

  it("keeps the per-wallet fallback dormant when the shared batch succeeds", () => {
    const { markup, readKeys } = renderBalance([
      [BATCH_KEY, { data: { [WALLET_ID]: [balance(12)] } }],
    ]);

    expect(readKeys).toContain(BATCH_KEY);
    expect(readKeys).not.toContain(FALLBACK_KEY);
    expect(markup).toContain("$12.00");
    expect(markup).not.toContain("DashboardCustody.stale");
  });

  it("loads only this wallet through the fallback when the shared batch fails", () => {
    const { markup, readKeys } = renderBalance([
      [BATCH_KEY, { error: new Error("batch unavailable") }],
      [FALLBACK_KEY, { data: [balance(10)] }],
    ]);

    expect(readKeys).toContain(FALLBACK_KEY);
    expect(markup).toContain("$10.00");
    expect(markup).not.toContain("DashboardCustody.stale");
  });

  it("keeps stale data marked when both the shared batch and this wallet fail", () => {
    const { markup } = renderBalance([
      [BATCH_KEY, { data: { [WALLET_ID]: [balance(3)] }, error: new Error("batch unavailable") }],
      [FALLBACK_KEY, { error: new Error("wallet unavailable") }],
    ]);

    expect(markup).toContain("$3.00");
    expect(markup).toContain("DashboardCustody.stale");
  });
});
