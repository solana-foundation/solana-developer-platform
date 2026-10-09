import {
  Children,
  type ComponentProps,
  type ElementType,
  isValidElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  solBalance,
  trackedBalances,
} from "@/app/dashboard/[projectId]/custody/wallet-balances.fixtures";
import { WalletLabelInlineEditor } from "@/app/dashboard/[projectId]/custody/wallet-label-inline-editor";
import { Callout } from "@/components/ui/callout";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { getTranslations } from "@/i18n/server";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

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

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock("@/flags", () => ({
  issuance: mockIssuanceFlag,
  policies: mockPoliciesFlag,
  privyByok: mockPrivyByokFlag,
}));

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

import WalletDetailPage, {
  WalletBalanceSummary,
  WalletBalancesSection,
  WalletControlsPanel,
} from "./wallet-detail-page";

function renderPage(walletId = "wallet_record") {
  return WalletDetailPage({ params: Promise.resolve({ walletId }) });
}

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function findElementProps<T extends ElementType>(
  node: ReactNode,
  type: T
): ComponentProps<T> | null {
  if (!isValidElement(node)) {
    return null;
  }

  if (node.type === type) {
    return node.props as ComponentProps<T>;
  }

  const { children } = node.props as { children?: ReactNode };
  for (const child of Children.toArray(children)) {
    const props = findElementProps(child, type);
    if (props) {
      return props;
    }
  }

  return null;
}

function findWalletLabelEditor(
  node: ReactNode
): ComponentProps<typeof WalletLabelInlineEditor> | null {
  return findElementProps(node, WalletLabelInlineEditor);
}

function renderWalletIdentity(page: ReactNode): string {
  const identity = findElementProps(page, "section");
  expect(identity).not.toBeNull();
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {identity?.children}
    </I18nProvider>
  );
}

beforeEach(() => {
  walletOverrides = {};
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet%2Fone`);
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
    if (path.startsWith("/v1/wallets/")) {
      return walletMetadataResponse();
    }

    if (path.includes("/balances")) {
      return Response.json({
        data: { walletBalances: { custodyWalletId: "wallet_record", balances: [solBalance("0")] } },
      });
    }

    if (path.includes("/policies")) {
      return new Response(null, { status: 404 });
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

describe("WalletDetailPage critical path", () => {
  it.each([404, 403, 503, "malformed", "network", "wrong wallet"] as const)(
    "shows unavailable balances and controls after a %s read failure",
    async (failure) => {
      mockRequest.mockImplementation(async (path: string) => {
        if (path.startsWith("/v1/wallets/")) return walletMetadataResponse();
        if (path.startsWith("/v1/issuance/tokens")) return Response.json({ data: [] });
        if (failure === "network") throw new Error("Unavailable");
        if (failure === "malformed") return Response.json({ data: {} });
        if (failure === "wrong wallet")
          return Response.json({
            data: {
              walletBalances: { custodyWalletId: "another_wallet", balances: [] },
              policy: {
                custodyWalletId: "another_wallet",
                walletId: "wallet/one",
                defaultAction: "allow",
                rules: [],
                controlProfile: null,
              },
            },
          });
        return new Response(null, { status: failure });
      });
      const page = await renderPage();
      const summary = findElementProps(page, WalletBalanceSummary);
      const controls = findElementProps(page, WalletControlsPanel);
      expect(summary).not.toBeNull();
      expect(controls).not.toBeNull();
      await expect(summary?.balancesPromise).resolves.toMatchObject({
        balances: [],
        error: "DashboardCustody.trackedBalancesUnavailable",
      });
      if (!controls) throw new Error("Wallet controls panel was not rendered");
      const controlMarkup = renderToStaticMarkup(await WalletControlsPanel(controls));
      expect(controlMarkup).toContain("DashboardCustody.walletControlsUnavailable");
      expect(controlMarkup).not.toContain("DashboardCustody.walletDefaultAllow");
      expect(mockRequest).toHaveBeenCalledWith("/v1/payments/wallets/wallet_record/balances");
      expect(mockRequest).toHaveBeenCalledWith("/v1/payments/wallets/wallet_record/policies");
    }
  );

  it("canonicalizes a provider bookmark before making Payments reads", async () => {
    await expect(renderPage("wallet%2Fone")).rejects.toThrow(
      `NEXT_REDIRECT /dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_record`
    );
    expect(mockRequest.mock.calls.some(([path]) => String(path).startsWith("/v1/payments/"))).toBe(
      false
    );
  });

  it.each([
    ["an admin while BYOK is off", "org:admin", false],
    ["a member", "org:member", true],
  ])(
    "keeps a connection-owned wallet readable without connection requests or links for %s",
    async (_viewer, orgRole, byokEnabled) => {
      walletOverrides = { custodyConnectionId: "connection_one" };
      mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole });
      mockPrivyByokFlag.mockResolvedValue(byokEnabled);

      const page = await renderPage();

      expect(
        mockRequest.mock.calls.some(([path]) => String(path).includes("/custody/connections"))
      ).toBe(false);
      const markup = renderWalletIdentity(page);
      expect(markup).toContain("Fast wallet");
      expect(markup).not.toContain("/integrations/privy/connections/");
    }
  );

  it("loads the wallet's exact connection and links its label for an admin with BYOK enabled", async () => {
    walletOverrides = { custodyConnectionId: "connection_one" };
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" });

    const page = await renderPage();

    expect(
      mockRequest.mock.calls.filter(([path]) => String(path).includes("/custody/connections"))
    ).toEqual([["/internal/dashboard/custody/connections/connection_one"]]);
    const markup = renderWalletIdentity(page);
    expect(markup).toContain(
      `href="/dashboard/${PRODUCTION_PROJECT.id}/integrations/privy/connections/connection_one"`
    );
    expect(markup).toContain("Treasury connection");
  });

  it.each(["http", "network", "invalid response"])(
    "keeps the wallet readable after a connection lookup %s failure",
    async (failure) => {
      walletOverrides = { custodyConnectionId: "connection_one" };
      mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" });
      mockRequest.mockImplementation(async (path: string) => {
        if (path.startsWith("/v1/wallets/")) return walletMetadataResponse();
        if (path === "/internal/dashboard/custody/connections/connection_one") {
          if (failure === "network") throw new Error("Connection unavailable");
          if (failure === "invalid response") return Response.json({ data: {} });
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 404 });
      });

      const page = await renderPage();

      const markup = renderWalletIdentity(page);
      expect(markup).toContain("Fast wallet");
      expect(markup).toContain("wallet_record");
      expect(markup).toContain("connection_one");
    }
  );

  it("keeps wallet detail data cards on theme-aware surfaces", async () => {
    const t = await getTranslations();
    const [summary, populatedBalances, emptyBalances] = await Promise.all([
      WalletBalanceSummary({
        walletId: "wallet_one",
        balancesPromise: Promise.resolve(trackedBalances([solBalance("0")], null)),
        providerLabel: "Privy",
        publicKey: "11111111111111111111111111111111",
        purposeLabel: null,
        t,
      }),
      WalletBalancesSection({
        walletId: "wallet_one",
        balancesPromise: Promise.resolve(trackedBalances([solBalance("0")], null)),
        ownedTokensByMintPromise: Promise.resolve(new Map()),
        issuanceEnabled: true,
        t,
      }),
      WalletBalancesSection({
        walletId: "wallet_one",
        balancesPromise: Promise.resolve(trackedBalances([], null)),
        ownedTokensByMintPromise: Promise.resolve(new Map()),
        issuanceEnabled: true,
        t,
      }),
    ]);
    const markup = [summary, populatedBalances, emptyBalances]
      .map((surface) =>
        renderToStaticMarkup(
          <I18nProvider locale="en" messages={getMessages("en")}>
            {surface}
          </I18nProvider>
        )
      )
      .join("\n");

    expect(markup.match(/bg-surface-raised/g)).toHaveLength(3);
    expect(markup).not.toMatch(/\bbg-white(?:\/\d+)?\b/);
  });

  it.each([
    ["org:admin", true],
    ["org:member", false],
  ])("reuses the wallet label editor for %s users", async (orgRole, canEdit) => {
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole });

    const page = await renderPage();

    expect(findWalletLabelEditor(page)).toEqual({
      canEdit,
      emptyLabel: "DashboardCustody.untitledWallet",
      label: "Fast wallet",
      walletId: "wallet_record",
    });
  });

  it("explains a signing restriction in the identity shell", async () => {
    walletOverrides = { isRuntimeExecutionAllowed: false };
    const restricted = await renderPage();
    expect(findElementProps(restricted, Callout)).toMatchObject({
      variant: "warning",
      title: "DashboardCustody.signingDisabledTitle",
    });

    walletOverrides = {};
    const allowed = await renderPage();
    expect(findElementProps(allowed, Callout)).toBeNull();
  });

  it("loads metadata only and leaves wallet activity off the initial render path", async () => {
    await renderPage();

    expect(mockLoadWalletActivity).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledWith("/v1/wallets/wallet_record?includeBalance=false");
  });

  it("does not load or render policy controls when Policies is disabled", async () => {
    mockPoliciesFlag.mockResolvedValue(false);

    const page = await renderPage();
    expect(page).toBeTruthy();

    expect(mockRequest.mock.calls.some(([path]) => String(path).includes("/policies"))).toBe(false);
  });

  it("resolves the identity shell while lower wallet sections are still pending", async () => {
    const balances = deferred<Response>();
    const policy = deferred<Response>();
    const ownedTokens = deferred<Response>();
    mockRequest.mockImplementation((path: string) => {
      if (path === "/v1/wallets/wallet_record?includeBalance=false") {
        return Promise.resolve(walletMetadataResponse());
      }
      if (path.includes("/balances")) return balances.promise;
      if (path.includes("/policies")) return policy.promise;
      if (path.startsWith("/v1/issuance/tokens")) return ownedTokens.promise;
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    const pagePromise = renderPage();

    try {
      const result = await Promise.race([
        pagePromise.then(() => "resolved" as const),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
      ]);

      expect(result).toBe("resolved");
    } finally {
      balances.resolve(
        Response.json({
          data: {
            walletBalances: { custodyWalletId: "wallet_record", balances: [solBalance("0")] },
          },
        })
      );
      policy.resolve(new Response(null, { status: 404 }));
      ownedTokens.resolve(Response.json({ data: [] }));
      await pagePromise;
    }
  });
});
