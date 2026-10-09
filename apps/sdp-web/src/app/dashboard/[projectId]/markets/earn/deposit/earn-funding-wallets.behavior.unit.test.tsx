// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEarnFundingWallets } from "./earn-funding-wallets";

const wallets = ["a", "b"].map((id) => ({
  id: `wallet-${id}`,
  walletId: `provider-${id}`,
  publicKey: `Pubkey${id.toUpperCase()}1111111111111111111111111111111111`,
  label: null,
  purpose: null,
  status: "active",
  isRuntimeExecutionAllowed: true,
  balances: [],
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

function stubWalletReads() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://sdp.test");
    if (url.pathname === "/api/dashboard/wallets") return Response.json({ data: { wallets } });
    const minimumSlot = url.searchParams.get("minimumSlot");
    return Response.json({
      data: {
        ...(minimumSlot ? { balanceReadContext: { minimumSlot: Number(minimumSlot) } } : {}),
        walletBalances: { balances: [] },
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const urls = () => fetchMock.mock.calls.map(([input]) => String(input));
  return { fetchMock, urls };
}

async function mounted() {
  const reads = stubWalletReads();
  const hook = renderHook(() => useEarnFundingWallets(), { wrapper });
  await waitFor(() => expect(hook.result.current.wallets).toHaveLength(2));
  reads.fetchMock.mockClear();
  return { ...reads, result: hook.result };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared funding wallet sweeps", () => {
  it("joins identical post-movement refreshes onto one sweep", async () => {
    const { urls, result } = await mounted();
    await act(async () => {
      await Promise.all([
        result.current.refreshBalances(101, ["wallet-a"]),
        result.current.refreshBalances(101, ["wallet-a"]),
      ]);
    });
    expect(urls()).toEqual([
      "/api/dashboard/wallets?view=summary&includeBalances=true&includeAllProviders=true",
      "/api/dashboard/payments/wallets/provider-a/balances?minimumSlot=101",
      "/api/dashboard/payments/wallets/provider-b/balances",
    ]);
  });

  it("starts a separate sweep when the floor changes", async () => {
    const { urls, result } = await mounted();
    await act(async () => {
      await Promise.all([
        result.current.refreshBalances(101, ["wallet-a"]),
        result.current.refreshBalances(102, ["wallet-a"]),
      ]);
    });
    expect(urls().filter((url) => url.includes("provider-a"))).toEqual([
      "/api/dashboard/payments/wallets/provider-a/balances?minimumSlot=102",
      "/api/dashboard/payments/wallets/provider-a/balances?minimumSlot=102",
    ]);
    expect(urls().filter((url) => url.startsWith("/api/dashboard/wallets?"))).toHaveLength(2);
  });

  it("lets a revalidation join a refresh only when both read the same floors live", async () => {
    const { urls, result, fetchMock } = await mounted();
    await act(async () => {
      await Promise.all([result.current.refreshBalances(), result.current.refresh()]);
    });
    expect(urls().filter((url) => url.startsWith("/api/dashboard/wallets?"))).toHaveLength(2);
    expect(urls().filter((url) => url.includes("/balances"))).toHaveLength(2);
    await act(async () => {
      await result.current.refreshBalances(101, ["wallet-a"]);
    });
    fetchMock.mockClear();
    await act(async () => {
      await Promise.all([
        result.current.refreshBalances(101, ["wallet-a"]),
        result.current.refresh(),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(urls()).toHaveLength(3);
  });
});
