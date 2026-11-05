// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import {
  type DashboardKeyScope,
  dashboardRequestKey,
  dashboardRequestUrl,
} from "@/lib/dashboard-request-key";
import { readsOf, sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { dvpQueryKeys } from "./dvp-query-key";
import { useDvpInboundTrades, useDvpTrade, useDvpTrades } from "./dvp-trades.data";
import { parseDvpTradesFilters } from "./dvp-trades-query";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };
const TRADES_PATH = "/api/dashboard/markets/dvp/trades";
const TRADE_PATH = `${TRADES_PATH}/dvp_1`;

function tradeFixture(overrides: Record<string, unknown>) {
  return { id: "dvp_1", status: "created", yourSide: "a", legs: { a: {}, b: {} }, ...overrides };
}

function answerTradeReads(answer: { trades: unknown[]; trade: unknown }) {
  return stubDashboardFetch(({ path }) =>
    Response.json({
      data:
        new URL(path, "https://dashboard.test").pathname === TRADE_PATH
          ? { trade: answer.trade }
          : { trades: answer.trades },
    })
  );
}

function useEveryTradeRead() {
  return {
    list: useDvpTrades(parseDvpTradesFilters({}).filters),
    inbound: useDvpInboundTrades(),
    detail: useDvpTrade("dvp_1"),
  };
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dvpQueryKeys.trades", () => {
  it.each([
    [{}, `${TRADES_PATH}?limit=50`],
    [{ status: "waiting" }, `${TRADES_PATH}?limit=50`],
    [
      { status: "ready", q: "USDC" },
      `${TRADES_PATH}?limit=50&q=USDC&settlementAvailability=available&status=funded`,
    ],
  ])("reads the URL filters %j as %s", (searchParams, url) => {
    const { filters } = parseDvpTradesFilters(searchParams);

    expect(dashboardRequestUrl(dvpQueryKeys.trades(SCOPE, filters))).toBe(url);
  });
});

describe("dvpQueryKeys.isTradeOrWalletRead", () => {
  it.each([
    ["the trade list", dvpQueryKeys.trades(SCOPE, parseDvpTradesFilters({}).filters), true],
    ["the inbound trades", dvpQueryKeys.inboundTrades(SCOPE), true],
    ["one trade", dvpQueryKeys.trade(SCOPE, { tradeId: "dvp_1" }), true],
    [
      "the shared wallet summaries",
      sharedReadQueryKeys.walletSummaries(SCOPE, { includeBalances: true }),
      true,
    ],
    [
      "a wallet's live balances",
      dashboardRequestKey(SCOPE, "/api/dashboard/payments/wallets/wal_test/balances"),
      true,
    ],
    ["the counterparty accounts", dvpQueryKeys.createCounterpartyAccounts(SCOPE), false],
    ["the Earn positions", earnQueryKeys.vaultPositions(SCOPE), false],
  ])("matches %s: %s", (_read, key, matches) => {
    expect(dvpQueryKeys.isTradeOrWalletRead(key)).toBe(matches);
  });
});

describe("useDvpTrades", () => {
  it("keeps the previous filter's trades on screen while the next filter's read is in flight", async () => {
    const readyAnswer = Promise.withResolvers<Response>();
    const fetchMock = stubDashboardFetch(({ path }) =>
      path.includes("status=funded")
        ? readyAnswer.promise
        : Response.json({ data: { trades: [tradeFixture({ id: "dvp_all" })] } })
    );
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => useDvpTrades(parseDvpTradesFilters({ status }).filters),
      { wrapper: DashboardReadsProvider, initialProps: { status: "all" } }
    );
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    rerender({ status: "ready" });

    await waitFor(() => expect(sentDashboardReads(fetchMock)).toHaveLength(2));
    expect(result.current.data?.map((trade) => trade.id)).toEqual(["dvp_all"]);
    await act(async () =>
      readyAnswer.resolve(Response.json({ data: { trades: [tradeFixture({ id: "dvp_ready" })] } }))
    );
    await waitFor(() =>
      expect(result.current.data?.map((trade) => trade.id)).toEqual(["dvp_ready"])
    );
  });
});

describe("trade reads", () => {
  it("drops an unreadable row from both lists and keeps the rest", async () => {
    answerTradeReads({ trades: [{}, tradeFixture({ id: "dvp_ok" })], trade: tradeFixture({}) });

    const { result } = renderHook(useEveryTradeRead, { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.inbound.data).toBeDefined());
    await waitFor(() => expect(result.current.list.data).toBeDefined());
    expect(result.current.list.data?.map((trade) => trade.id)).toEqual(["dvp_ok"]);
    expect(result.current.inbound.data?.map((trade) => trade.id)).toEqual(["dvp_ok"]);
  });

  it.each([
    ["an empty object", {}],
    ["no legs", { id: "dvp_1", status: "created" }],
    ["only one leg", { id: "dvp_1", status: "created", legs: { a: {} } }],
    ["a null leg", { id: "dvp_1", status: "created", legs: { a: {}, b: null } }],
    ["legs that are not objects", { id: "dvp_1", status: "created", legs: { a: 1, b: 2 } }],
  ])("fails a 200 carrying %s as a read, never as an absent trade", async (_shape, trade) => {
    answerTradeReads({ trades: [], trade });

    const { result } = renderHook(() => useDvpTrade("dvp_1"), { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.error).toMatchObject({ status: 200, code: null }));
    expect(result.current.data).toBeUndefined();
  });

  it.each([
    { id: "", name: "Treasury", isRuntimeExecutionAllowed: true },
    { id: "cw_1", name: { label: "Treasury" }, isRuntimeExecutionAllowed: true },
    { id: "cw_1", name: null, isRuntimeExecutionAllowed: "true" },
    { id: "cw_1", name: null },
  ])("refuses an invalid action wallet on every trade read: %j", async (actionWallet) => {
    const trade = tradeFixture({ legs: { a: { party: { actionWallet } }, b: {} } });
    answerTradeReads({ trades: [trade], trade });

    const { result } = renderHook(useEveryTradeRead, { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.detail.error).toMatchObject({ status: 200 }));
    await waitFor(() => expect(result.current.inbound.data).toEqual([]));
    await waitFor(() => expect(result.current.list.data).toEqual([]));
  });

  it.each([
    null,
    { id: "cw_config", name: "Treasury", isRuntimeExecutionAllowed: true },
    { id: "cw_connection", name: null, isRuntimeExecutionAllowed: false },
  ])("keeps a valid or unavailable action wallet on every trade read: %j", async (actionWallet) => {
    const trade = tradeFixture({ legs: { a: { party: { actionWallet } }, b: {} } });
    answerTradeReads({ trades: [trade], trade });

    const { result } = renderHook(useEveryTradeRead, { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.detail.data).toBeDefined());
    await waitFor(() => expect(result.current.inbound.data).toHaveLength(1));
    await waitFor(() => expect(result.current.list.data).toHaveLength(1));
    expect(result.current.detail.data?.legs.a.party.actionWallet).toEqual(actionWallet);
    expect(result.current.list.data?.[0]?.legs.a.party.actionWallet).toEqual(actionWallet);
    expect(result.current.inbound.data?.[0]?.legs.a.party.actionWallet).toEqual(actionWallet);
  });
});

describe("useDvpTrade", () => {
  it("re-reads an open trade every six seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = answerTradeReads({
      trades: [],
      trade: tradeFixture({ status: "partially_funded" }),
    });
    const { result } = renderHook(() => useDvpTrade("dvp_1"), { wrapper: DashboardReadsProvider });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(() => vi.advanceTimersByTimeAsync(6_000));

    await waitFor(() => expect(readsOf(fetchMock, TRADE_PATH)).toBe(2));
  });

  it("stops reading a settled trade", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = answerTradeReads({ trades: [], trade: tradeFixture({ status: "settled" }) });
    const { result } = renderHook(() => useDvpTrade("dvp_1"), { wrapper: DashboardReadsProvider });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(readsOf(fetchMock, TRADE_PATH)).toBe(1);
  });
});
