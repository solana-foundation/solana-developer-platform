// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createRef, type ReactNode, type Ref, useImperativeHandle } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
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
    expect(urls()).toEqual(["/api/dashboard/payments/wallets/provider-a/balances?minimumSlot=101"]);
  });

  it("starts a separate sweep when the floor changes", async () => {
    const { urls, result } = await mounted();
    await act(async () => {
      const outcomes = await Promise.allSettled([
        result.current.refreshBalances(101, ["wallet-a"]),
        result.current.refreshBalances(102, ["wallet-a"]),
      ]);
      expect(outcomes[1]?.status).toBe("fulfilled");
    });
    expect(urls().filter((url) => url.includes("provider-a"))).toEqual([
      "/api/dashboard/payments/wallets/provider-a/balances?minimumSlot=101",
      "/api/dashboard/payments/wallets/provider-a/balances?minimumSlot=102",
    ]);
    expect(urls().filter((url) => url.startsWith("/api/dashboard/wallets?"))).toHaveLength(0);
  });

  it("keeps discovery revalidation separate from a targeted balance refresh", async () => {
    const { urls, result, fetchMock } = await mounted();
    await act(async () => {
      await Promise.all([result.current.refreshBalances(), result.current.refresh()]);
    });
    expect(urls().filter((url) => url.startsWith("/api/dashboard/wallets?"))).toHaveLength(1);
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
    expect(urls()).toHaveLength(4);
  });
});

function tokenBalances(uiAmount: string) {
  return [{ token: "USDC", mint: "mint", amount: uiAmount, uiAmount, decimals: 0 }];
}

function deferredRead() {
  let complete: (amount: string) => void = () => {};
  let fail: () => void = () => {};
  const response = new Promise<Response>((resolve) => {
    fail = () => resolve(Response.json({ error: "RPC unavailable" }, { status: 503 }));
    complete = (amount) =>
      resolve(
        Response.json({
          data: {
            balanceReadContext: { minimumSlot: 1_000 },
            walletBalances: { balances: tokenBalances(amount) },
          },
        })
      );
  });
  return { response, complete, fail };
}

describe("targeted funding wallet observations", () => {
  it("preserves unrelated balances when a different wallet refresh completes", async () => {
    const { result, fetchMock } = await mounted();
    const a = deferredRead();
    const b = deferredRead();
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("provider-a") ? a.response : b.response
    );
    let readA: Promise<unknown> = Promise.resolve();
    let readB: Promise<unknown> = Promise.resolve();
    act(() => {
      readA = result.current.refreshBalances(101, ["wallet-a"]);
      readB = result.current.refreshBalances(102, ["wallet-b"]);
    });
    await act(async () => {
      b.complete("20");
      await readB;
    });
    await act(async () => {
      a.complete("10");
      await readA;
    });
    expect(result.current.wallets?.map((wallet) => wallet.balances?.[0]?.uiAmount)).toEqual([
      "10",
      "20",
    ]);
  });

  it("keeps a newer same-wallet observation when an older request finishes last", async () => {
    const { result, fetchMock, urls } = await mounted();
    const older = deferredRead();
    const newer = deferredRead();
    fetchMock
      .mockImplementationOnce(async () => older.response)
      .mockImplementationOnce(async () => newer.response);
    let oldRead: Promise<unknown> = Promise.resolve();
    let newRead: Promise<unknown> = Promise.resolve();
    act(() => {
      oldRead = result.current.refreshBalances(101, ["wallet-a"]);
      newRead = result.current.refreshBalances(102, ["wallet-a"]);
    });
    await act(async () => {
      newer.complete("20");
      await newRead;
    });
    await act(async () => {
      older.complete("10");
      await oldRead;
    });
    expect(result.current.wallets?.[0]?.balances?.[0]?.uiAmount).toBe("20");
    expect(urls()).toHaveLength(2);
  });

  it("does not publish a failed or insufficiently fresh balance", async () => {
    const { result, fetchMock } = await mounted();
    const original = result.current.wallets;
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: {
          balanceReadContext: { minimumSlot: 100 },
          walletBalances: { balances: tokenBalances("50") },
        },
      })
    );
    await act(async () => {
      await expect(result.current.refreshBalances(101, ["wallet-a"])).rejects.toThrow(
        "confirmation freshness"
      );
    });
    expect(result.current.wallets).toBe(original);
    fetchMock.mockResolvedValueOnce(Response.json({ error: "RPC unavailable" }, { status: 503 }));
    await act(async () => {
      await expect(result.current.refreshBalances(101, ["wallet-a"])).rejects.toThrow("503");
    });
    expect(result.current.wallets).toBe(original);
  });
});

async function mountedConsumers() {
  const reads = stubWalletReads();
  const hook = renderHook(
    () => ({ treasury: useEarnFundingWallets(), dialog: useEarnFundingWallets() }),
    { wrapper }
  );
  await waitFor(() => expect(hook.result.current.dialog.wallets).toHaveLength(2));
  reads.fetchMock.mockClear();
  return { ...reads, result: hook.result };
}

describe("shared funding wallet coordination", () => {
  it("joins the Treasury and dialog reads for the same wallet and floor", async () => {
    const { result, urls } = await mountedConsumers();
    await act(async () => {
      await Promise.all([
        result.current.treasury.refreshBalances(101, ["wallet-a"]),
        result.current.dialog.refreshBalances(101, ["wallet-a"]),
      ]);
    });
    expect(urls()).toEqual(["/api/dashboard/payments/wallets/provider-a/balances?minimumSlot=101"]);
  });

  it("keeps the newer read when another consumer's older request finishes last", async () => {
    const { result, fetchMock } = await mountedConsumers();
    const older = deferredRead();
    const newer = deferredRead();
    fetchMock
      .mockImplementationOnce(async () => older.response)
      .mockImplementationOnce(async () => newer.response);
    let oldRead: Promise<unknown> = Promise.resolve();
    let newRead: Promise<unknown> = Promise.resolve();
    act(() => {
      oldRead = result.current.treasury.refreshBalances(101, ["wallet-a"]);
      newRead = result.current.dialog.refreshBalances(102, ["wallet-a"]);
    });
    await act(async () => {
      newer.complete("20");
      await newRead;
    });
    await act(async () => {
      older.complete("10");
      await oldRead;
    });
    expect(result.current.treasury.wallets?.[0]?.balances?.[0]?.uiAmount).toBe("20");
    expect(result.current.dialog.wallets?.[0]?.balances?.[0]?.uiAmount).toBe("20");
  });

  it("does not publish an older floor when a newer consumer's required read fails", async () => {
    const { result, fetchMock } = await mountedConsumers();
    const original = result.current.treasury.wallets;
    const older = deferredRead();
    fetchMock
      .mockImplementationOnce(async () => older.response)
      .mockResolvedValueOnce(Response.json({ error: "RPC unavailable" }, { status: 503 }));
    let oldRead: Promise<unknown> = Promise.resolve();
    let rejectedOld: Promise<void> = Promise.resolve();
    await act(async () => {
      oldRead = result.current.treasury.refreshBalances(101, ["wallet-a"]);
      rejectedOld = expect(oldRead).rejects.toThrow(
        "A newer wallet balance confirmation is pending"
      );
      await expect(result.current.dialog.refreshBalances(102, ["wallet-a"])).rejects.toThrow("503");
    });
    await act(async () => {
      older.complete("10");
      await rejectedOld;
    });
    expect(result.current.treasury.wallets).toBe(original);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: {
          balanceReadContext: { minimumSlot: 102 },
          walletBalances: { balances: tokenBalances("20") },
        },
      })
    );
    await act(async () => {
      await result.current.treasury.refreshBalances(101, ["wallet-a"]);
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/dashboard/payments/wallets/provider-a/balances?minimumSlot=102",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(result.current.dialog.wallets?.[0]?.balances?.[0]?.uiAmount).toBe("20");
  });

  it("does not share floors, in-flight work, or late publication across project/org cache scopes", async () => {
    const reads = stubWalletReads();
    let scope = "org-a/project-a";
    const scopedWrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig
        key={scope}
        value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
      >
        {children}
      </SWRConfig>
    );
    const { result, rerender } = renderHook(() => useEarnFundingWallets(), {
      wrapper: scopedWrapper,
    });
    await waitFor(() => expect(result.current.wallets).toHaveLength(2));
    const older = deferredRead();
    reads.fetchMock.mockImplementationOnce(async () => older.response);
    let oldRead: Promise<unknown> = Promise.resolve();
    act(() => {
      oldRead = result.current.refreshBalances(101, ["wallet-a"]);
    });
    scope = "org-b/project-b";
    rerender();
    await waitFor(() => expect(result.current.wallets).toHaveLength(2));
    const newScopeWallets = result.current.wallets;
    await act(async () => {
      older.complete("10");
      await oldRead;
    });
    expect(result.current.wallets).toBe(newScopeWallets);
    reads.fetchMock.mockClear();
    await act(async () => {
      result.current.refresh();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(reads.urls()).toEqual(["/api/dashboard/wallets?view=summary&includeBalances=true"]);
  });
});

it("keeps a newer published balance when the older consumer's request fails", async () => {
  const { result, fetchMock } = await mountedConsumers();
  const older = deferredRead();
  const newer = deferredRead();
  fetchMock
    .mockImplementationOnce(async () => older.response)
    .mockImplementationOnce(async () => newer.response);
  let oldRead: Promise<unknown> = Promise.resolve();
  let rejectedOld: Promise<void> = Promise.resolve();
  let newRead: Promise<unknown> = Promise.resolve();
  act(() => {
    oldRead = result.current.treasury.refreshBalances(101, ["wallet-a"]);
    rejectedOld = expect(oldRead).rejects.toThrow("503");
    newRead = result.current.dialog.refreshBalances(102, ["wallet-a"]);
  });
  await act(async () => {
    newer.complete("20");
    await newRead;
  });
  await act(async () => {
    older.fail();
    await rejectedOld;
  });
  expect(result.current.treasury.wallets?.[0]?.balances?.[0]?.uiAmount).toBe("20");
});

it("does not repopulate an invalidated wallet inventory from an older targeted read", async () => {
  const reads = stubWalletReads();
  const { result } = renderHook(
    () => ({ funding: useEarnFundingWallets(), mutate: useSWRConfig().mutate }),
    { wrapper }
  );
  await waitFor(() => expect(result.current.funding.wallets).toHaveLength(2));
  const older = deferredRead();
  reads.fetchMock.mockImplementationOnce(async () => older.response);
  let rejectedRead: Promise<void> = Promise.resolve();
  await act(async () => {
    rejectedRead = expect(
      result.current.funding.refreshBalances(101, ["wallet-a"])
    ).rejects.toThrow("Wallet inventory changed");
    await result.current.mutate(earnQueryKeys.fundingWallets(), undefined, { revalidate: false });
  });
  await act(async () => {
    older.complete("10");
    await rejectedRead;
  });
  expect(result.current.funding.wallets).toBeUndefined();
});

it("discovers a newly added wallet before refreshing that wallet alone", async () => {
  const { result, fetchMock, urls } = await mounted();
  const newWallet = {
    ...wallets[0],
    id: "wallet-c",
    walletId: "provider-c",
    publicKey: "PubkeyC1111111111111111111111111111111111",
  };
  fetchMock
    .mockResolvedValueOnce(Response.json({ data: { wallets: [...wallets, newWallet] } }))
    .mockResolvedValueOnce(
      Response.json({
        data: {
          balanceReadContext: { minimumSlot: 101 },
          walletBalances: { balances: tokenBalances("30") },
        },
      })
    );
  await act(async () => {
    await result.current.refreshBalances(101, ["wallet-c"]);
  });
  expect(urls()).toEqual([
    "/api/dashboard/wallets?view=summary&includeBalances=true",
    "/api/dashboard/payments/wallets/provider-c/balances?minimumSlot=101",
  ]);
  expect(
    result.current.wallets?.find((wallet) => wallet.id === "wallet-c")?.balances?.[0]?.uiAmount
  ).toBe("30");
});

function FundingWalletConsumer({ ref }: { ref: Ref<ReturnType<typeof useEarnFundingWallets>> }) {
  const funding = useEarnFundingWallets();
  useImperativeHandle(ref, () => funding, [funding]);
  return null;
}

it("does not start a wallet refresh after every consumer unmounts", async () => {
  const reads = stubWalletReads();
  const { result, unmount } = renderHook(() => useEarnFundingWallets(), { wrapper });
  await waitFor(() => expect(result.current.wallets).toHaveLength(2));
  const refreshBalances = result.current.refreshBalances;
  reads.fetchMock.mockClear();
  unmount();
  await expect(refreshBalances(101, ["wallet-a"])).resolves.toBeUndefined();
  expect(reads.fetchMock).not.toHaveBeenCalled();
});

it("publishes a shared observation after its initiating dialog closes", async () => {
  const reads = stubWalletReads();
  const dialog = createRef<ReturnType<typeof useEarnFundingWallets>>();
  let showDialog = true;
  function sharedWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
      >
        {children}
        {showDialog ? <FundingWalletConsumer ref={dialog} /> : null}
      </SWRConfig>
    );
  }
  const { result, rerender } = renderHook(() => useEarnFundingWallets(), {
    wrapper: sharedWrapper,
  });
  await waitFor(() => expect(result.current.wallets).toHaveLength(2));
  const initiatingDialog = dialog.current;
  if (initiatingDialog === null) throw new Error("Dialog did not mount");
  const pending = deferredRead();
  reads.fetchMock.mockImplementationOnce(async () => pending.response);
  let read: Promise<unknown> = Promise.resolve();
  act(() => {
    read = initiatingDialog.refreshBalances(101, ["wallet-a"]);
  });
  showDialog = false;
  rerender();
  await act(async () => {
    pending.complete("10");
    await read;
  });
  expect(result.current.wallets?.[0]?.balances?.[0]?.uiAmount).toBe("10");
});

it("does not replace a live no-floor refresh with a newer cached inventory revalidation", async () => {
  const { result, fetchMock, urls } = await mounted();
  const live = deferredRead();
  const cachedWallets = wallets.map((wallet) => ({ ...wallet, balances: tokenBalances("5") }));
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/dashboard/wallets?"))
      return Response.json({ data: { wallets: cachedWallets } });
    if (url.includes("provider-a")) return live.response;
    return Response.json({ data: { walletBalances: { balances: [] } } });
  });
  let refresh: Promise<unknown> = Promise.resolve();
  act(() => {
    refresh = result.current.refreshBalances();
  });
  await waitFor(() => expect(urls().some((url) => url.includes("provider-a"))).toBe(true));
  await act(async () => {
    result.current.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    live.complete("10");
    await refresh;
  });
  expect(result.current.wallets?.[0]?.balances?.[0]?.uiAmount).toBe("10");
  expect(urls().filter((url) => url.startsWith("/api/dashboard/wallets?"))).toHaveLength(1);
});
