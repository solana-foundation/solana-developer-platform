import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "user", orgId: "org" }) }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/i18n/server", () => ({
  getRequestLocale: async () => "en",
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/sdp-api", async (original) => ({
  ...(await original<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: async () => ({ request }),
}));
vi.mock("@/app/dashboard/[projectId]/payments/payments-page.data", () => ({
  fetchIssuedTokensByMint: async () => ({}),
}));

import WalletPolicyAuditDetailPage from "./[policyEvaluationId]/page";
import WalletPolicyAuditPage from "./page";

beforeEach(() => {
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/provider_a/policy/audit`);
  request.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/wallets/"))
      return Response.json({ data: { wallet: { id: "cwlt_a", walletId: "provider_a" } } });
    if (path.endsWith("/revisions"))
      return Response.json({ data: { profile: null, revisions: [] } });
    if (path.endsWith("/eval_a"))
      return Response.json({ data: { policyEvaluation: { id: "eval_a" } } });
    if (path.includes("/evaluations?"))
      return Response.json({ data: [], meta: { total: 0, page: 1, pageSize: 25, hasMore: false } });
    if (path === "/v1/api-keys") return Response.json({ data: { apiKeys: [] } });
    return Response.json({ data: { members: [] } });
  });
});

describe("policy audit canonical identity", () => {
  it.each([
    [WalletPolicyAuditPage, ""],
    [WalletPolicyAuditDetailPage, "/eval_a"],
  ] as const)(
    "canonicalizes legacy audit URLs while preserving their filters",
    async (Page, suffix) => {
      await expect(
        Page({
          params: Promise.resolve({ walletId: "provider_a", policyEvaluationId: "eval_a" }),
          searchParams: Promise.resolve({ decision: "deny" }),
        })
      ).rejects.toThrow(
        `NEXT_REDIRECT /dashboard/${PRODUCTION_PROJECT.id}/wallets/cwlt_a/policy/audit${suffix}?decision=deny`
      );
      expect(
        request.mock.calls
          .filter(([path]) => String(path).startsWith("/v1/payments/"))
          .every(([path]) => String(path).startsWith("/v1/payments/wallets/cwlt_a/"))
      ).toBe(true);
    }
  );
});
