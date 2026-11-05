// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import type { Token } from "@sdp/types/tokens";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issuanceQueryKeys } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-query-key";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import type { DashboardKeyScope, DashboardRequestKey } from "@/lib/dashboard-request-key";
import { useDashboardSWR } from "@/lib/dashboard-swr";
import { stubClerkSession } from "@/test/clerk";
import { SANDBOX_PROJECT } from "@/test/projects";
import { useTokenOperationData } from "./use-token-operation-data";

beforeEach(() => {
  stubClerkSession();
});
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const wallet: PaymentsDashboardWallet = {
  id: "cwlt_a",
  custodyConfigId: "ccfg_a",
  walletId: "provider_a",
  isRuntimeExecutionAllowed: true,
  publicKey: "address_a",
  label: "Wallet A",
};
function authoritiesBody() {
  return {
    data: {
      allowlistAuthority: null,
      freezeAuthority: null,
      metadataAuthority: null,
      pauseAuthority: null,
    },
  };
}
function walletsBody(wallets: PaymentsDashboardWallet[]) {
  return { data: { wallets } };
}
const token: Token = {
  id: "tok_test",
  organizationId: "org_test",
  projectId: "prj_test",
  signingCustodyWalletId: wallet.id,
  signingWalletId: wallet.walletId,
  name: "Draft token",
  symbol: "DRAFT",
  decimals: 6,
  description: "Original description",
  template: "custom",
  status: "pending",
  mintAddress: null,
  mintAuthority: null,
  metadataAuthority: null,
  freezeAuthority: null,
  ablListAddress: null,
  uri: null,
  imageUrl: null,
  extensions: null,
  totalSupply: "0",
  maxSupply: null,
  isMintable: true,
  isFreezable: false,
  requiresAllowlist: false,
  deployedAt: null,
  createdBy: "user_test",
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:00:00Z",
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={<div>Loading workspace</div>}
        dashboardAccess={resolveDashboardAccess("admin")}
        flags={{
          assetProfiles: true,
          compliance: false,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: true,
          markets: false,
          payments: false,
          privateChannels: false,
          releaseChannel: "experimental",
          ramps: false,
        }}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[]}
      >
        <SWRConfig value={{ shouldRetryOnError: false, dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function renderData(input: Token) {
  return renderHook(
    () =>
      useTokenOperationData({
        token: input,
        shouldLoadAuthorityWallets: true,
      }),
    { wrapper }
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads authority wallets", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("includeAllowlistAuthority=true")) return Response.json(authoritiesBody());
      if (url.startsWith("/api/dashboard/wallets")) return Response.json(walletsBody([wallet]));
      throw new Error(`Unexpected URL: ${url}`);
    })
  );
  const { result } = renderData(token);
  await waitFor(() => expect(result.current.authorityWallets).toEqual([wallet]));
  expect(result.current.authorityWallets).toEqual([wallet]);
  expect(result.current.authorityWalletsError).toBeNull();
});

it("loads frozen-account totals for a deployed token after freeze authority is revoked", async () => {
  const deployedToken = {
    ...token,
    status: "active" as const,
    mintAddress: "58NU6ZxKq3aVv2q1s9bJcYtvHkbEwLmPqRs4TuVwVjVu",
    isFreezable: false,
    freezeAuthority: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("includeAllowlistAuthority=true")) return Response.json(authoritiesBody());
      if (url.startsWith("/api/dashboard/wallets")) return Response.json(walletsBody([wallet]));
      if (url.endsWith("/frozen")) return Response.json({ data: [], error: null, total: 3 });
      throw new Error(`Unexpected URL: ${url}`);
    })
  );

  const { result } = renderData(deployedToken);

  await waitFor(() => expect(result.current.frozenAccountsTotal).toBe(3));
  expect(result.current.frozenAccountsError).toBeNull();
});

it("reports a failed wallet request through authorityWalletsError", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("includeAllowlistAuthority=true")) return Response.json(authoritiesBody());
      if (url.startsWith("/api/dashboard/wallets")) {
        return Response.json({ error: { message: "Wallet lookup denied" } }, { status: 503 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    })
  );
  const { result } = renderData(token);
  await waitFor(() => expect(result.current.authorityWalletsError).toBe("Wallet lookup denied"));
  expect(result.current.authorityWallets).toEqual([]);
});

it("keeps wallet failure blocking even when previous inventories were cached", async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("includeAllowlistAuthority=true")) return Response.json(authoritiesBody());
    if (url.startsWith("/api/dashboard/wallets")) return Response.json(walletsBody([wallet]));
    throw new Error(`Unexpected URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const first = renderData(token);
  await waitFor(() => expect(first.result.current.authorityWalletsLoading).toBe(false));
  expect(first.result.current.authorityWallets).toEqual([wallet]);
  first.unmount();

  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("includeAllowlistAuthority=true")) return Response.json(authoritiesBody());
    if (url.startsWith("/api/dashboard/wallets")) throw new Error("Wallet inventory unavailable");
    throw new Error(`Unexpected URL: ${url}`);
  });
  const second = renderData(token);
  await waitFor(() =>
    expect(second.result.current.authorityWalletsError).toBe("Wallet inventory unavailable")
  );
  expect(second.result.current.authorityWallets).toEqual([]);
});

const OTHER_TOKEN_ID = "tok_test_other";
const READ_SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };

function readsOf(tokenId: string) {
  return {
    allowlistPage: issuanceQueryKeys.tokenAllowlist(READ_SCOPE, {
      tokenId,
      page: 2,
      pageSize: 25,
      search: "treasury",
      label: null,
    }),
    allowlistLabels: issuanceQueryKeys.tokenAllowlistLabels(READ_SCOPE, { tokenId }),
    transactionsPage: issuanceQueryKeys.tokenTransactions(READ_SCOPE, {
      tokenId,
      page: 1,
      pageSize: 10,
    }),
    frozenAccounts: issuanceQueryKeys.frozenAccounts(READ_SCOPE, { tokenId }),
  };
}

function useTokenReads(tokenId: string, fetcher: (key: DashboardRequestKey) => Promise<string>) {
  const reads = readsOf(tokenId);
  useDashboardSWR(reads.allowlistPage, fetcher);
  useDashboardSWR(reads.allowlistLabels, fetcher);
  useDashboardSWR(reads.transactionsPage, fetcher);
  useDashboardSWR(reads.frozenAccounts, fetcher);
}

it("refreshes the token's access-list, transactions and frozen reads after an operation, and no other token's", async () => {
  const fetcher = vi.fn(async (key: DashboardRequestKey) => key[2]);
  const { result } = renderHook(
    () => {
      useTokenReads(token.id, fetcher);
      useTokenReads(OTHER_TOKEN_ID, fetcher);
      return useTokenOperationData({ token, shouldLoadAuthorityWallets: false });
    },
    { wrapper }
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(8));

  await act(() => result.current.revalidateAfterSuccess());

  expect(fetcher.mock.calls.slice(8).map(([key]) => key)).toEqual(Object.values(readsOf(token.id)));
});
