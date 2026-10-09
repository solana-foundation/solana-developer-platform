import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user", orgId: "org" }),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/lib/sdp-api", async (original) => ({
  ...(await original<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: async () => ({ request }),
  createOrgSdpApiClient: async () => ({ fetch: async () => ({ organization: null }) }),
}));
vi.mock("./policy-assets.data", () => ({ getIssuedPolicyTokens: async () => [] }));
vi.mock("./wallet-policy-starting-profile-flow", () => ({
  WalletPolicyStartingProfileFlow: () => null,
}));

import WalletPolicyPage from "./page";

beforeEach(() => {
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/cwlt_a/policy`);
  request.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/wallets/")) {
      return Response.json({
        data: {
          wallet: { id: "cwlt_a", walletId: "provider_a", publicKey: "address", label: "A" },
        },
      });
    }
    if (path.endsWith("/balances"))
      return Response.json({ data: { walletBalances: { balances: [] } } });
    return new Response(null, { status: 404 });
  });
});

describe("WalletPolicyPage identity", () => {
  it.each([true, false])(
    "accepts an unconfigured policy with legacy metadata present=%s",
    async (legacy) => {
      request.mockImplementation(async (path: string) => {
        if (path.startsWith("/v1/wallets/"))
          return Response.json({ data: { wallet: { id: "cwlt_a", walletId: "provider_a" } } });
        if (path.endsWith("/policies"))
          return Response.json({
            data: {
              policy: {
                custodyWalletId: "cwlt_a",
                ...(legacy ? { walletId: "provider_a" } : {}),
                defaultAction: "allow",
                rules: [],
                controlProfile: null,
              },
            },
          });
        return Response.json({
          data: { walletBalances: { custodyWalletId: "cwlt_a", balances: [] } },
        });
      });
      const page = await WalletPolicyPage({
        params: Promise.resolve({ walletId: "cwlt_a" }),
        searchParams: Promise.resolve({}),
      });
      expect(page.props.policyError).toBeNull();
      expect(page.props.initialPolicy).toMatchObject({
        custodyWalletId: "cwlt_a",
        defaultAction: "allow",
        rules: [],
      });
    }
  );

  it("passes an unavailable policy state and exact target to the authoring form", async () => {
    const page = await WalletPolicyPage({
      params: Promise.resolve({ walletId: "cwlt_a" }),
      searchParams: Promise.resolve({}),
    });
    expect(page.key).toBe(`${PRODUCTION_PROJECT.id}:cwlt_a`);
    expect(page.props.wallet).toMatchObject({ id: "cwlt_a", walletId: "provider_a" });
    expect(page.props.policyError).toBe("Wallet controls are unavailable right now.");
    expect(request).toHaveBeenCalledWith("/v1/payments/wallets/cwlt_a/policies");
    expect(request).toHaveBeenCalledWith("/v1/payments/wallets/cwlt_a/balances");
  });

  it("canonicalizes a provider bookmark while preserving its revision", async () => {
    await expect(
      WalletPolicyPage({
        params: Promise.resolve({ walletId: "provider_a" }),
        searchParams: Promise.resolve({ revision: "latest" }),
      })
    ).rejects.toThrow(
      `NEXT_REDIRECT /dashboard/${PRODUCTION_PROJECT.id}/wallets/cwlt_a/policy?revision=latest`
    );
    expect(request.mock.calls.some(([path]) => String(path).startsWith("/v1/payments/"))).toBe(
      false
    );
  });
});
