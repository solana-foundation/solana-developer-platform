import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { type ComponentProps, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { setPageRequest } from "@/test/request-project";

const {
  mockAuth,
  mockFetchProjectProviderAvailability,
  mockIssuanceFlag,
  mockLoadWalletActivity,
  mockRequest,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFetchProjectProviderAvailability: vi.fn(),
  mockIssuanceFlag: vi.fn(),
  mockLoadWalletActivity: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/provider-availability.server", () => ({
  fetchProjectProviderAvailability: mockFetchProjectProviderAvailability,
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock("@/flags", () => ({
  issuance: mockIssuanceFlag,
}));
vi.mock("@/flags/new-design", () => ({ isNewDesignOn: async () => false }));

vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: vi.fn(async () => ({ request: mockRequest })),
}));

vi.mock("@/app/dashboard/[projectId]/custody/wallet-activity.data", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/app/dashboard/[projectId]/custody/wallet-activity.data")
    >();
  return {
    ...actual,
    loadWalletActivity: mockLoadWalletActivity,
  };
});

import { WalletDetailPage } from "./wallet-detail-page.redesign";
import { WalletDetailView } from "./wallet-detail-view";

const solBalance: CustodyWalletTokenBalance = {
  token: "SOL",
  mint: "So11111111111111111111111111111111111111112",
  amount: "0",
  uiAmount: "0",
  decimals: 9,
};

let walletOverrides: Record<string, unknown> = {};

function walletMetadataResponse(): Response {
  return Response.json({
    data: {
      wallet: {
        id: "wallet_record",
        custodyConfigId: "config_test",
        provider: "privy",
        isDefaultProvider: true,
        isRuntimeExecutionAllowed: true,
        ...walletOverrides,
        walletId: "wallet/one",
        publicKey: "11111111111111111111111111111111",
        label: "Fast wallet",
        purpose: null,
        status: "active",
        createdAt: "2026-07-18T00:00:00.000Z",
      },
    },
  });
}

beforeEach(() => {
  walletOverrides = {};
  mockAuth.mockReset();
  mockIssuanceFlag.mockReset();
  mockLoadWalletActivity.mockReset();
  mockFetchProjectProviderAvailability.mockReset();
  mockRequest.mockReset();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_record`);

  mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
  mockIssuanceFlag.mockResolvedValue(true);
  mockLoadWalletActivity.mockResolvedValue({
    ok: true,
    data: {
      activityRows: [],
      activityError: null,
      activityNotice: null,
    },
  });
  mockRequest.mockImplementation(async (path: string) => {
    if (
      path.startsWith("/v1/wallets/wallet%2Fone") ||
      path.startsWith("/v1/wallets/wallet_record")
    ) {
      return walletMetadataResponse();
    }

    if (path.includes("/balances")) {
      return Response.json({
        data: {
          walletBalances: {
            custodyWalletId: "wallet_record",
            address: "11111111111111111111111111111111",
            balances: [solBalance],
          },
        },
      });
    }

    if (path.startsWith("/v1/issuance/tokens")) {
      return Response.json({ data: [] });
    }

    if (path === "/internal/dashboard/custody/connections/connection_one") {
      return Response.json({
        data: {
          connection: {
            id: "connection_one",
            provider: "privy",
            label: "Treasury connection",
            status: "active",
            completion: null,
            isDefault: true,
            canComplete: false,
            canReplaceCredentials: false,
            canCancel: false,
          },
        },
      });
    }

    throw new Error(`Unexpected request: ${path}`);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

type ViewProps = ComponentProps<typeof WalletDetailView>;

async function renderPage(): Promise<ViewProps> {
  const page = (await WalletDetailPage({
    params: Promise.resolve({ walletId: "wallet_record" }),
    searchParams: Promise.resolve({}),
  })) as ReactNode;
  expect(isValidElement(page)).toBe(true);
  if (!isValidElement(page)) throw new Error("no element");
  expect(page.type).toBe(WalletDetailView);
  return page.props as ViewProps;
}

const requested = (fragment: string) =>
  mockRequest.mock.calls.some(([path]) => String(path).includes(fragment));

describe("WalletDetailPage", () => {
  it("preserves a bookmarked tab and repeated query values when canonicalizing", async () => {
    mockRequest.mockImplementation(async () => walletMetadataResponse());
    await expect(
      WalletDetailPage({
        params: Promise.resolve({ walletId: "wallet%2Fone" }),
        searchParams: Promise.resolve({
          tab: "settings",
          filter: ["a", "b"],
          label: "Wallet & Treasury",
          empty: "",
          absent: undefined,
        }),
      })
    ).rejects.toThrow(
      `/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_record?tab=settings&filter=a&filter=b&label=Wallet+%26+Treasury&empty=`
    );
    expect(mockRequest.mock.calls.some(([path]) => String(path).includes("/payments/"))).toBe(
      false
    );
  });

  it("canonicalizes a legacy bookmark before reading Payments balances", async () => {
    await expect(
      WalletDetailPage({
        params: Promise.resolve({ walletId: "wallet%2Fone" }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_record`);
    expect(requested("/payments/")).toBe(false);
  });

  it("preserves the empty balance display for a missing tracked balance", async () => {
    const base = mockRequest.getMockImplementation();
    if (!base) throw new Error("Wallet detail request fixture is missing");
    mockRequest.mockImplementation(async (path: string) =>
      path.includes("/balances") ? new Response(null, { status: 404 }) : base(path)
    );

    const props = await renderPage();

    await expect(props.balancesPromise).resolves.toEqual({ balances: [], error: null });
    expect(mockRequest).toHaveBeenCalledWith("/v1/payments/wallets/wallet_record/balances");
  });

  it.each(["wrong-wallet", "missing-identity", "invalid-balance"] as const)(
    "reports an unavailable balance for %s instead of an empty wallet",
    async (failure) => {
      const base = mockRequest.getMockImplementation();
      if (!base) throw new Error("Wallet detail request fixture is missing");
      mockRequest.mockImplementation(async (path: string) => {
        if (!path.includes("/balances")) return base(path);
        const custodyWalletId = (() => {
          switch (failure) {
            case "missing-identity":
              return undefined;
            case "wrong-wallet":
              return "wrong_wallet";
            case "invalid-balance":
              return "wallet_record";
            default: {
              const exhaustive: never = failure;
              throw new Error(`Unsupported balance failure: ${exhaustive}`);
            }
          }
        })();
        return Response.json({
          data: {
            walletBalances: {
              custodyWalletId,
              address: "11111111111111111111111111111111",
              balances: failure === "invalid-balance" ? [{}] : [],
            },
          },
        });
      });
      const props = await renderPage();
      await expect(props.balancesPromise).resolves.toEqual({
        balances: [],
        error: "DashboardCustody.trackedBalancesUnavailable",
      });
    }
  );

  it("names the wallet and its provider, and says what it can sign", async () => {
    const { wallet } = await renderPage();
    expect(wallet).toMatchObject({
      walletId: "wallet/one",
      custodyWalletId: "wallet_record",
      name: "Fast wallet",
      label: "Fast wallet",
      provider: "privy",
      providerName: "Privy",
      createdAt: "2026-07-18T00:00:00.000Z",
      isRuntimeExecutionAllowed: true,
      connection: null,
    });
  });

  it("calls an unlabelled wallet untitled rather than by its address", async () => {
    walletOverrides = { label: null };
    mockRequest.mockImplementationOnce(async () =>
      Response.json({
        data: {
          wallet: {
            id: "wallet_record",
            custodyConfigId: "config_test",
            provider: "privy",
            isRuntimeExecutionAllowed: true,
            walletId: "wallet/one",
            publicKey: "11111111111111111111111111111111",
            label: null,
            purpose: null,
            status: "active",
            createdAt: "2026-07-18T00:00:00.000Z",
          },
        },
      })
    );
    const { wallet } = await renderPage();
    expect(wallet.name).toBe("DashboardCustody.untitledWallet");
    expect(wallet.label).toBeNull();
  });

  it("does not request admin-only connection data for a member", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:member" });
    const { wallet } = await renderPage();
    expect(requested("/connections/")).toBe(false);
    expect(mockFetchProjectProviderAvailability).not.toHaveBeenCalled();
    expect(wallet.connection).toEqual({ label: "connec..._one", href: null });
    expect(wallet.canManageCustody).toBe(false);
  });

  it("loads the wallet's exact connection and links its label for an admin", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" });
    mockFetchProjectProviderAvailability.mockResolvedValue(
      projectProviderAvailability({
        project: PRODUCTION_PROJECT,
        custody: [{ provider: "privy", modes: ["byok"] }],
        compliance: [],
        ramps: [],
        earn: [],
      })
    );
    const { wallet } = await renderPage();
    expect(wallet.connection).toEqual({
      label: "Treasury connection",
      href: `/dashboard/${PRODUCTION_PROJECT.id}/integrations/privy/connections/connection_one`,
    });
    expect(wallet.canManageCustody).toBe(true);
  });

  it("leaves the connection label unlinked for an admin when the project does not offer privy in byok", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" });
    mockFetchProjectProviderAvailability.mockResolvedValue(
      projectProviderAvailability({
        project: PRODUCTION_PROJECT,
        custody: [],
        compliance: [],
        ramps: [],
        earn: [],
      })
    );
    const { wallet } = await renderPage();
    expect(wallet.connection).toEqual({ label: "Treasury connection", href: null });
  });

  it("loads metadata only and hands the lower parts over as promises", async () => {
    const props = await renderPage();
    expect(mockRequest).toHaveBeenCalledWith("/v1/wallets/wallet_record?includeBalance=false");
    await expect(props.balancesPromise).resolves.toEqual({ balances: [solBalance], error: null });
    await expect(props.issuedTokensPromise).resolves.toEqual({});
  });

  it("renders the page while the balances are still on their way", async () => {
    const balances = deferred<Response>();
    const base = mockRequest.getMockImplementation();
    mockRequest.mockImplementation(async (path: string) =>
      path.includes("/balances") ? balances.promise : base?.(path)
    );
    const props = await renderPage();
    expect(props.wallet.name).toBe("Fast wallet");
    balances.resolve(
      Response.json({
        data: {
          walletBalances: {
            custodyWalletId: "wallet_record",
            address: "11111111111111111111111111111111",
            balances: [],
          },
        },
      })
    );
    await expect(props.balancesPromise).resolves.toEqual({ balances: [], error: null });
  });
});
