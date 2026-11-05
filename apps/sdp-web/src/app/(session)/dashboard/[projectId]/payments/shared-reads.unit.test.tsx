// @vitest-environment jsdom

import { API_KEY_WALLET_SCOPES, SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import type { PrivateChannelInstance } from "@sdp/types/private-channels";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUANCE_MAX_PAGE_SIZE } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-list-query";
import { DashboardReadError } from "@/lib/dashboard-swr";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import {
  useApiKey,
  useIssuedTokens,
  useOrganizationProviderAccess,
  usePrivateChannelInstance,
  useWalletSummaries,
} from "./shared-reads";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const FIRST_PAGE_URL = `/api/dashboard/issuance/tokens?page=1&pageSize=${ISSUANCE_MAX_PAGE_SIZE}`;
const SECOND_PAGE_URL = `/api/dashboard/issuance/tokens?page=2&pageSize=${ISSUANCE_MAX_PAGE_SIZE}`;
const FIRST_PAGE = {
  data: [
    {
      id: "tok_test_one",
      name: "Token One",
      decimals: 6,
      mintAddress: "MintOne1111111111111111111111111111111111111",
      symbol: "ONE",
      imageUrl: "https://assets.test/one.png",
    },
    {
      id: "tok_test_draft",
      name: "Draft Token",
      decimals: 6,
      mintAddress: null,
      symbol: "DRAFT",
      imageUrl: null,
    },
  ],
  total: ISSUANCE_MAX_PAGE_SIZE + 4,
  hasMore: true,
};
const SECOND_PAGE = {
  data: [
    {
      id: "",
      name: "Token Two",
      decimals: 0,
      mintAddress: "MintTwo2222222222222222222222222222222222222",
      symbol: "TWO",
    },
    {
      id: "tok_test_unminted",
      name: "Unminted Token",
      decimals: 6,
      mintAddress: "",
      symbol: "EMPTY",
      imageUrl: null,
    },
  ],
  total: ISSUANCE_MAX_PAGE_SIZE + 4,
  hasMore: false,
};

function DemoReads({ children }: { children: ReactNode }) {
  return (
    <DashboardReadsProvider>
      <PaymentsDemoProvider value={true}>{children}</PaymentsDemoProvider>
    </DashboardReadsProvider>
  );
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useWalletSummaries", () => {
  it("reads again on the refresh interval its caller passes", async () => {
    vi.useFakeTimers();
    const fetchMock = stubDashboardFetch(() => Response.json({ data: { wallets: [] } }));
    renderHook(() => useWalletSummaries({ includeBalances: false }, { refreshInterval: 5_000 }), {
      wrapper: DashboardReadsProvider,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
      "/api/dashboard/wallets?view=summary",
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
      "/api/dashboard/wallets?view=summary",
      "/api/dashboard/wallets?view=summary",
    ]);
  });
});

describe("useIssuedTokens", () => {
  it("reads page after page in the key's mode until the last, keeping only minted tokens", async () => {
    const fetchMock = stubDashboardFetch(({ path }) =>
      Response.json(path === SECOND_PAGE_URL ? SECOND_PAGE : FIRST_PAGE)
    );

    const { result } = renderHook(() => useIssuedTokens(true), { wrapper: DemoReads });

    await waitFor(() =>
      expect(result.current.data).toEqual([
        {
          id: "tok_test_one",
          name: "Token One",
          decimals: 6,
          mintAddress: "MintOne1111111111111111111111111111111111111",
          symbol: "ONE",
          imageUrl: "https://assets.test/one.png",
        },
        {
          id: null,
          name: "Token Two",
          decimals: 0,
          mintAddress: "MintTwo2222222222222222222222222222222222222",
          symbol: "TWO",
          imageUrl: null,
        },
      ])
    );
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: FIRST_PAGE_URL, projectId: SANDBOX_PROJECT.id, demo: "1" },
      { path: SECOND_PAGE_URL, projectId: SANDBOX_PROJECT.id, demo: "1" },
    ]);
  });

  it("stops once the pages read cover the listing's total, even while it says there is more", async () => {
    const fetchMock = stubDashboardFetch(() => Response.json(FIRST_PAGE));

    const { result } = renderHook(() => useIssuedTokens(true), { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
      FIRST_PAGE_URL,
      SECOND_PAGE_URL,
    ]);
  });

  it("sends nothing while disabled", async () => {
    const fetchMock = stubDashboardFetch(() => Response.json(SECOND_PAGE));

    const { result } = renderHook(() => useIssuedTokens(false), {
      wrapper: DashboardReadsProvider,
    });
    await act(() => Promise.resolve());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});

describe("useOrganizationProviderAccess", () => {
  const [EARN_PROVIDER] = EARN_PROVIDERS;
  const ACCESS = { entitled: true, configured: true, enabled: false };

  it("reads under the key's Project, keeping every ramp and only the Earn providers it knows", async () => {
    const fetchMock = stubDashboardFetch(() =>
      Response.json({
        data: {
          providers: {
            ramps: { moonpay: ACCESS, ramp_test_new: ACCESS },
            earn: { [EARN_PROVIDER]: ACCESS, earn_test_new: ACCESS },
          },
        },
      })
    );

    const { result } = renderHook(() => useOrganizationProviderAccess(), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() =>
      expect(result.current.data).toEqual({
        ramps: { moonpay: ACCESS, ramp_test_new: ACCESS },
        earn: { [EARN_PROVIDER]: ACCESS },
      })
    );
    expect(sentDashboardReads(fetchMock)).toEqual([
      {
        path: "/api/dashboard/organizations/current/provider-access",
        projectId: SANDBOX_PROJECT.id,
        demo: null,
      },
    ]);
  });

  it("surfaces a failed read as an error with no access", async () => {
    stubDashboardFetch(() => new Response("down", { status: 503 }));

    const { result } = renderHook(() => useOrganizationProviderAccess(), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(DashboardReadError));
    expect(result.current.data).toBeUndefined();
  });
});

describe("usePrivateChannelInstance and useApiKey", () => {
  const INSTANCE: PrivateChannelInstance = {
    id: "pci_test_1",
    organizationId: "org_test",
    projectId: SANDBOX_PROJECT.id,
    isActive: true,
    createdBy: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    gatewayUrl: "https://gateway.test",
    chainRpcUrl: "https://rpc.test",
    escrowProgramId: "escrow_program_test",
    withdrawProgramId: "withdraw_program_test",
    escrowInstanceAddr: "escrow_instance_test",
    authUrl: "https://auth.test",
  };
  const [SANDBOX_ENVIRONMENT] = SDP_ENVIRONMENTS;
  const [ALL_WALLETS] = API_KEY_WALLET_SCOPES;
  const API_KEY = {
    id: "key_test/1",
    name: "Test key",
    environment: SANDBOX_ENVIRONMENT,
    grants: [],
    expiresAt: null,
    walletScope: ALL_WALLETS,
    walletIds: [],
    allowedIps: null,
  };

  it("sends nothing for an instance read that is off or an API key that is null", async () => {
    const fetchMock = stubDashboardFetch(() => Response.json({ data: { instance: null } }));
    renderHook(() => [usePrivateChannelInstance(false), useApiKey(null)], {
      wrapper: DashboardReadsProvider,
    });
    await act(() => Promise.resolve());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[INSTANCE], [null]])("returns the Project's instance, or null: %j", async (instance) => {
    stubDashboardFetch(() => Response.json({ data: { instance } }));
    const { result } = renderHook(() => usePrivateChannelInstance(true), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.data).toEqual(instance));
  });

  it("reads one API key at its encoded id", async () => {
    const fetchMock = stubDashboardFetch(() => Response.json({ data: API_KEY }));
    const { result } = renderHook(() => useApiKey(API_KEY.id), { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.data).toEqual(API_KEY));
    expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
      "/api/dashboard/api-keys/key_test%2F1",
    ]);
  });
});
