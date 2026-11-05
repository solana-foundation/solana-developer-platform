// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardErrorResponse,
  readsOf,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishDashboardReads } from "@/test/dashboard-reads";
import { TOKEN_2022_PROGRAM, useDvpCreateContext } from "./dvp-create.data";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const WALLETS_URL = "/api/dashboard/wallets?view=summary";
const TOKENS_URL = "/api/dashboard/issuance/tokens?page=1&pageSize=100";
const ACCOUNTS_URL = "/api/dashboard/counterparty/accounts?pageSize=100";

const CONFIG_WALLET = {
  id: "cwlt_test_config",
  walletId: "provider_test_config",
  publicKey: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
  label: "Treasury",
  custodyConfigId: "cc_test",
  isRuntimeExecutionAllowed: true,
};
const CONNECTION_WALLET = {
  id: "cwlt_test_connection",
  walletId: "provider_test_connection",
  publicKey: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
  label: null,
  custodyConnectionId: "conn_test",
  isRuntimeExecutionAllowed: false,
};
const TOKENS_PAGE = {
  data: [
    {
      id: "tok_test_bond",
      name: "Test Bond",
      decimals: 6,
      mintAddress: "MintBond",
      symbol: "TBOND",
    },
    { id: "tok_test_named", name: "Named", decimals: 2, mintAddress: "MintNamed", symbol: "" },
    { id: "tok_test_draft", name: "Draft", decimals: 6, mintAddress: null, symbol: "DRAFT" },
  ],
  total: 3,
  hasMore: false,
};
const ACCOUNT = {
  counterpartyAccountId: "cpa_test",
  name: "Acme OTC",
  label: "Settlement wallet",
  address: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC",
};

function stubCreateReads(failing: string | null, apiMessage: string) {
  return stubDashboardFetch(({ path }) => {
    if (path === failing) return dashboardErrorResponse(503, apiMessage);
    if (path === WALLETS_URL) {
      return Response.json({ data: { wallets: [CONFIG_WALLET, CONNECTION_WALLET] } });
    }
    if (path === TOKENS_URL) return Response.json(TOKENS_PAGE);
    return Response.json({ data: { accounts: [ACCOUNT, { name: "No address" }] } });
  });
}

function renderContext(issuanceEnabled: boolean) {
  return renderHook(() => useDvpCreateContext(issuanceEnabled), {
    wrapper: EnglishDashboardReads,
  });
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useDvpCreateContext", () => {
  it("offers the Project's wallets, minted tokens and counterparty accounts", async () => {
    const fetchMock = stubCreateReads(null, "");

    const { result } = renderContext(true);

    await waitFor(() => expect(result.current.context).toBeDefined());
    expect(result.current.context).toEqual({
      wallets: [
        {
          id: CONFIG_WALLET.id,
          address: CONFIG_WALLET.publicKey,
          label: "Treasury",
          custodyConfigId: "cc_test",
          custodyConnectionId: undefined,
          isRuntimeExecutionAllowed: true,
          balances: null,
        },
        {
          id: CONNECTION_WALLET.id,
          address: CONNECTION_WALLET.publicKey,
          label: null,
          custodyConfigId: undefined,
          custodyConnectionId: "conn_test",
          isRuntimeExecutionAllowed: false,
          balances: null,
        },
      ],
      tokens: [
        {
          mint: "MintBond",
          label: "TBOND",
          name: "Test Bond",
          decimals: 6,
          tokenProgram: TOKEN_2022_PROGRAM,
        },
        {
          mint: "MintNamed",
          label: "Named",
          name: "Named",
          decimals: 2,
          tokenProgram: TOKEN_2022_PROGRAM,
        },
      ],
      counterpartyAccounts: [ACCOUNT],
      error: null,
    });
    expect(
      sentDashboardReads(fetchMock)
        .map((read) => read.path)
        .sort()
    ).toEqual([ACCOUNTS_URL, TOKENS_URL, WALLETS_URL]);
  });

  it("offers no issued tokens and reads no listing while Issuance is off", async () => {
    const fetchMock = stubCreateReads(null, "");

    const { result } = renderContext(false);

    await waitFor(() => expect(result.current.context).toBeDefined());
    expect(result.current.context).toMatchObject({ tokens: [], error: null });
    expect(readsOf(fetchMock, TOKENS_URL)).toBe(0);
  });

  it.each([
    [WALLETS_URL, "Wallets unavailable.", "Wallets unavailable.", 0, 0],
    [WALLETS_URL, "", "Wallets could not be loaded.", 0, 0],
    [TOKENS_URL, "Issuance unavailable.", "Issuance unavailable.", 2, 0],
    [TOKENS_URL, "", "Issued tokens could not be loaded.", 2, 0],
    [ACCOUNTS_URL, "Accounts unavailable.", "Accounts unavailable.", 2, 2],
    [ACCOUNTS_URL, "", "Counterparty accounts could not be loaded.", 2, 2],
  ])(
    "names a failed %s read (API message %j) and keeps the options read before it",
    async (failing, apiMessage, shown, wallets, tokens) => {
      stubCreateReads(failing, apiMessage);

      const { result } = renderContext(true);

      await waitFor(() => expect(result.current.context?.error).toBe(shown));
      expect(result.current.context?.wallets).toHaveLength(wallets);
      expect(result.current.context?.tokens).toHaveLength(tokens);
      expect(result.current.context?.counterpartyAccounts).toEqual([]);
    }
  );

  it("reads again only what failed when the reader retries", async () => {
    const fetchMock = stubCreateReads(TOKENS_URL, "Issuance unavailable.");
    const { result } = renderContext(true);
    await waitFor(() => expect(result.current.context?.error).toBe("Issuance unavailable."));

    act(() => result.current.retry());

    await waitFor(() => expect(readsOf(fetchMock, TOKENS_URL)).toBe(2));
    expect(readsOf(fetchMock, WALLETS_URL)).toBe(1);
    expect(readsOf(fetchMock, ACCOUNTS_URL)).toBe(1);
  });
});
