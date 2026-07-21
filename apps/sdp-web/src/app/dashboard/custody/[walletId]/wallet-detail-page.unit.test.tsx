import type { CustodyWalletTokenBalance } from "@sdp/types";
import { Children, type ComponentProps, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletLabelInlineEditor } from "@/app/dashboard/custody/wallet-label-inline-editor";
import { getTranslations } from "@/i18n/server";

const { mockAuth, mockLoadWalletActivity, mockRequest } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLoadWalletActivity: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mockAuth,
}));

vi.mock("next/navigation", () => ({
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

import WalletDetailPage, { WalletBalanceSummary, WalletBalancesSection } from "./page";

const solBalance: CustodyWalletTokenBalance = {
  token: "SOL",
  mint: "So11111111111111111111111111111111111111112",
  amount: "0",
  uiAmount: "0",
  decimals: 9,
};

function walletMetadataResponse(): Response {
  return Response.json({
    data: {
      wallet: {
        id: "wallet_record",
        custodyConfigId: "config_test",
        provider: "privy",
        isDefaultProvider: true,
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

function findWalletLabelEditor(
  node: ReactNode
): ComponentProps<typeof WalletLabelInlineEditor> | null {
  if (!isValidElement(node)) {
    return null;
  }

  if (node.type === WalletLabelInlineEditor) {
    return node.props as ComponentProps<typeof WalletLabelInlineEditor>;
  }

  const { children } = node.props as { children?: ReactNode };
  for (const child of Children.toArray(children)) {
    const editorProps = findWalletLabelEditor(child);
    if (editorProps) {
      return editorProps;
    }
  }

  return null;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockLoadWalletActivity.mockReset();
  mockRequest.mockReset();

  mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
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

    if (path.includes("/policies")) {
      return new Response(null, { status: 404 });
    }

    if (path.startsWith("/v1/issuance/tokens")) {
      return Response.json({ data: [] });
    }

    throw new Error(`Unexpected request: ${path}`);
  });
});

describe("WalletDetailPage critical path", () => {
  it("keeps wallet detail data cards on theme-aware surfaces", async () => {
    const t = await getTranslations();
    const balanceResult = { balances: [solBalance], error: null };
    const [summary, populatedBalances, emptyBalances] = await Promise.all([
      WalletBalanceSummary({
        balancesPromise: Promise.resolve(balanceResult),
        providerLabel: "Privy",
        publicKey: "11111111111111111111111111111111",
        purposeLabel: null,
        t,
      }),
      WalletBalancesSection({
        balancesPromise: Promise.resolve(balanceResult),
        ownedTokensByMintPromise: Promise.resolve(new Map()),
        t,
      }),
      WalletBalancesSection({
        balancesPromise: Promise.resolve({ balances: [], error: null }),
        ownedTokensByMintPromise: Promise.resolve(new Map()),
        t,
      }),
    ]);
    const markup = [summary, populatedBalances, emptyBalances]
      .map((surface) => renderToStaticMarkup(surface))
      .join("\n");

    expect(markup.match(/bg-surface-raised/g)).toHaveLength(3);
    expect(markup).not.toMatch(/\bbg-white(?:\/\d+)?\b/);
  });

  it.each([
    ["org:admin", true],
    ["org:member", false],
  ])("reuses the wallet label editor for %s users", async (orgRole, canEdit) => {
    mockAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole });

    const page = await WalletDetailPage({
      params: Promise.resolve({ walletId: "wallet%2Fone" }),
    });

    expect(findWalletLabelEditor(page)).toEqual({
      canEdit,
      emptyLabel: "DashboardCustody.untitledWallet",
      label: "Fast wallet",
      walletId: "wallet/one",
    });
  });

  it("loads metadata only and leaves wallet activity off the initial render path", async () => {
    await WalletDetailPage({ params: Promise.resolve({ walletId: "wallet%2Fone" }) });

    expect(mockLoadWalletActivity).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledWith("/v1/wallets/wallet%2Fone?includeBalance=false");
  });

  it("resolves the identity shell while lower wallet sections are still pending", async () => {
    const balances = deferred<Response>();
    const policy = deferred<Response>();
    const ownedTokens = deferred<Response>();
    mockRequest.mockImplementation((path: string) => {
      if (path === "/v1/wallets/wallet%2Fone?includeBalance=false") {
        return Promise.resolve(walletMetadataResponse());
      }
      if (path.includes("/balances")) return balances.promise;
      if (path.includes("/policies")) return policy.promise;
      if (path.startsWith("/v1/issuance/tokens")) return ownedTokens.promise;
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    const pagePromise = WalletDetailPage({
      params: Promise.resolve({ walletId: "wallet%2Fone" }),
    });

    try {
      const result = await Promise.race([
        pagePromise.then(() => "resolved" as const),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
      ]);

      expect(result).toBe("resolved");
    } finally {
      balances.resolve(Response.json({ data: { walletBalances: { balances: [solBalance] } } }));
      policy.resolve(new Response(null, { status: 404 }));
      ownedTokens.resolve(Response.json({ data: [] }));
      await pagePromise;
    }
  });
});
