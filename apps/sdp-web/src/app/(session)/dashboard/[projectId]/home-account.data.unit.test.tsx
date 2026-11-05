// @vitest-environment jsdom

import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardReadError } from "@/lib/dashboard-swr";
import { sentDashboardReads } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import {
  failedHomeRead,
  HOME_READ_URLS,
  type HomeReadAnswers,
  issuedTokensResponse,
  stubHomeReads,
  walletAggregateResponse,
  walletSummariesResponse,
} from "@/test/home-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { type HomeAccountState, resolveHomeAccount, useHomeAccount } from "./home-account.data";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

type HomeReads = Parameters<typeof resolveHomeAccount>[0];

const BALANCES: CustodyWalletTokenBalance[] = [
  {
    token: "USDC",
    mint: "mint_test_usdc",
    amount: "250000000",
    uiAmount: "250",
    decimals: 6,
    usdValue: 250,
  },
  {
    token: "SOL",
    mint: "mint_test_sol",
    amount: "500000000",
    uiAmount: "0.5",
    decimals: 9,
    usdValue: 50.5,
  },
];
const ISSUED_TOKENS = [
  {
    id: "tok_test_acme",
    name: "Acme",
    mintAddress: "mint_test_acme",
    symbol: "ACME",
    imageUrl: null,
  },
];
const AGGREGATE = { walletCount: 2, balances: BALANCES };

const pending = { data: undefined, error: undefined };
const failed = { data: undefined, error: new DashboardReadError(503, null, null) };
function answered<T>(data: T) {
  return { data, error: undefined };
}

function sandboxRead(path: string) {
  return { path, projectId: SANDBOX_PROJECT.id, demo: null };
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resolveHomeAccount", () => {
  it.each<[string, HomeReads, HomeAccountState["status"]]>([
    [
      "loading while the issued-token listing is pending",
      { aggregate: answered(AGGREGATE), wallets: answered(["wal_test_1"]), issuedTokens: pending },
      "loading",
    ],
    [
      "loading while the aggregate is pending, even beside an empty wallet list",
      { aggregate: pending, wallets: answered([]), issuedTokens: answered(ISSUED_TOKENS) },
      "loading",
    ],
    [
      "loading while a failed aggregate waits on the wallet list",
      { aggregate: failed, wallets: pending, issuedTokens: answered(ISSUED_TOKENS) },
      "loading",
    ],
    [
      "unavailable when the aggregate failed and wallets exist",
      {
        aggregate: failed,
        wallets: answered(["wal_test_1"]),
        issuedTokens: answered(ISSUED_TOKENS),
      },
      "unavailable",
    ],
    [
      "unavailable when the aggregate and the wallet list both failed",
      { aggregate: failed, wallets: failed, issuedTokens: answered(ISSUED_TOKENS) },
      "unavailable",
    ],
    [
      "unavailable when the issued-token listing failed",
      { aggregate: answered(AGGREGATE), wallets: answered(["wal_test_1"]), issuedTokens: failed },
      "unavailable",
    ],
  ])("is %s", (_case, reads, status) => {
    expect(resolveHomeAccount(reads)).toEqual({ status });
  });

  it("answers from the aggregate's data with its total, even beside failed re-reads", () => {
    const account = resolveHomeAccount({
      aggregate: { data: AGGREGATE, error: failed.error },
      wallets: failed,
      issuedTokens: { data: ISSUED_TOKENS, error: failed.error },
    });

    expect(account).toMatchObject({
      status: "ready",
      walletCount: 2,
      totalBalance: 300.5,
      issuedTokens: ISSUED_TOKENS,
    });
  });

  it("is a first run when the aggregate failed and the wallet list is empty", () => {
    const account = resolveHomeAccount({
      aggregate: failed,
      wallets: answered([]),
      issuedTokens: answered(ISSUED_TOKENS),
    });

    expect(account).toMatchObject({
      status: "ready",
      walletCount: 0,
      balances: [],
      totalBalance: null,
    });
  });
});

describe("useHomeAccount", () => {
  it("never requests the issued-token listing with Issuance off", async () => {
    const fetchMock = stubHomeReads({
      aggregate: () => walletAggregateResponse(1, []),
      wallets: () => walletSummariesResponse(["wal_test_1"]),
      issuedTokens: () => issuedTokensResponse([]),
    });

    const { result } = renderHook(() => useHomeAccount(false), { wrapper: DashboardReadsProvider });

    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "ready", walletCount: 1, issuedTokens: [] })
    );
    expect(sentDashboardReads(fetchMock)).toEqual([
      sandboxRead(HOME_READ_URLS.aggregate),
      sandboxRead(HOME_READ_URLS.wallets),
    ]);
  });

  it("re-reads only the reads that failed on retry", async () => {
    const answers: HomeReadAnswers = {
      aggregate: failedHomeRead,
      wallets: failedHomeRead,
      issuedTokens: () => issuedTokensResponse([]),
    };
    const fetchMock = stubHomeReads(answers);
    const { result } = renderHook(() => useHomeAccount(true), { wrapper: DashboardReadsProvider });
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    const account = result.current;
    if (account.status !== "unavailable") throw new Error("Expected an unavailable account");
    answers.aggregate = () => walletAggregateResponse(1, []);
    answers.wallets = () => walletSummariesResponse(["wal_test_1"]);
    fetchMock.mockClear();

    act(() => account.retry());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(sentDashboardReads(fetchMock)).toEqual([
      sandboxRead(HOME_READ_URLS.aggregate),
      sandboxRead(HOME_READ_URLS.wallets),
    ]);
  });
});
