import type { CustodyWalletTokenBalance } from "@sdp/types";
import { type ComponentProps, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuth,
  mockIssuanceFlag,
  mockLoadWalletActivity,
  mockPoliciesFlag,
  mockPrivyByokFlag,
  mockRequest,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockIssuanceFlag: vi.fn(),
  mockLoadWalletActivity: vi.fn(),
  mockPoliciesFlag: vi.fn(),
  mockPrivyByokFlag: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mockAuth,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
  redirect: vi.fn(() => {
    throw new Error("redirected");
  }),
}));

vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock("@/flags", () => ({
  issuance: mockIssuanceFlag,
  policies: mockPoliciesFlag,
  privyByok: mockPrivyByokFlag,
}));

vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: vi.fn(async () => ({ request: mockRequest })),
}));

vi.mock("@/app/dashboard/custody/wallet-activity.data", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/dashboard/custody/wallet-activity.data")>();
  return {
    ...actual,
    loadWalletActivity: mockLoadWalletActivity,
  };
});

import WalletDetailPage from "./wallet-detail-page";
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
  mockPoliciesFlag.mockReset();
  mockPrivyByokFlag.mockReset();
  mockRequest.mockReset();

  mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
  mockIssuanceFlag.mockResolvedValue(true);
  mockPoliciesFlag.mockResolvedValue(true);
  mockPrivyByokFlag.mockResolvedValue(true);
  mockLoadWalletActivity.mockResolvedValue({
    ok: true,
    data: {
      activityRows: [],
      activityError: null,
      activityNotice: null,
    },
  });
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/wallets/wallet%2Fone")) {
      return walletMetadataResponse();
    }

    if (path.includes("/balances")) {
      return Response.json({ data: { walletBalances: { balances: [solBalance] } } });
    }

    if (path.includes("/policies/revisions")) {
      return Response.json({ data: { profile: null, revisions: [] } });
    }

    if (path.includes("/policies")) {
      return new Response(null, { status: 404 });
    }

    if (path.startsWith("/v1/members")) {
      return Response.json({ data: [] });
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
    params: Promise.resolve({ walletId: "wallet%2Fone" }),
  })) as ReactNode;
  expect(isValidElement(page)).toBe(true);
  if (!isValidElement(page)) throw new Error("no element");
  expect(page.type).toBe(WalletDetailView);
  return page.props as ViewProps;
}

const requested = (fragment: string) =>
  mockRequest.mock.calls.some(([path]) => String(path).includes(fragment));

describe("WalletDetailPage", () => {
  it("names the wallet and its provider, and says what it can sign", async () => {
    const { wallet } = await renderPage();
    expect(wallet).toMatchObject({
      walletId: "wallet/one",
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

  it("keeps a connection-owned wallet readable without connection requests or links when BYOK is off", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" });
    mockPrivyByokFlag.mockResolvedValue(false);
    const { wallet } = await renderPage();
    expect(wallet.connection).toEqual({ label: "connec..._one", href: null });
    expect(requested("/connections/")).toBe(false);
  });

  it("does not request admin-only connection data for a member", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:member" });
    const { wallet } = await renderPage();
    expect(requested("/connections/")).toBe(false);
    expect(wallet.connection?.href).toBeNull();
    expect(wallet.canManageCustody).toBe(false);
  });

  it("loads the wallet's exact connection and links its label for an admin with BYOK enabled", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" });
    const { wallet } = await renderPage();
    expect(wallet.connection).toEqual({
      label: "Treasury connection",
      href: "/dashboard/integrations/privy/connections/connection_one",
    });
    expect(wallet.canManageCustody).toBe(true);
  });

  it("loads metadata only and hands the lower parts over as promises", async () => {
    const props = await renderPage();
    expect(mockRequest).toHaveBeenCalledWith("/v1/wallets/wallet%2Fone?includeBalance=false");
    await expect(props.balancesPromise).resolves.toEqual({ balances: [solBalance], error: null });
    await expect(props.issuedTokensPromise).resolves.toEqual({});
    await expect(props.policyPromise).resolves.toMatchObject({
      policy: { walletId: "wallet/one", defaultAction: "allow", controlProfile: null },
      error: null,
    });
    await expect(props.revisionsPromise).resolves.toMatchObject({ error: null });
  });

  it("does not load the policy or its revisions when Policies is disabled", async () => {
    mockPoliciesFlag.mockResolvedValue(false);
    const props = await renderPage();
    expect(props.policyPromise).toBeNull();
    expect(props.revisionsPromise).toBeNull();
    expect(requested("/policies")).toBe(false);
  });

  it("renders the page while the balances are still on their way", async () => {
    const balances = deferred<Response>();
    const base = mockRequest.getMockImplementation();
    mockRequest.mockImplementation(async (path: string) =>
      path.includes("/balances") ? balances.promise : base?.(path)
    );
    const props = await renderPage();
    expect(props.wallet.name).toBe("Fast wallet");
    balances.resolve(Response.json({ data: { walletBalances: { balances: [] } } }));
    await expect(props.balancesPromise).resolves.toEqual({ balances: [], error: null });
  });
});
