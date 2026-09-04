import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  custody: vi.fn(),
  payments: vi.fn(),
  policies: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("server-only", () => ({}));
vi.mock("@/flags", () => ({
  custody: mocks.custody,
  payments: mocks.payments,
  policies: mocks.policies,
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth-entry", () => ({ getAuthEntryPath: async () => "/sign-in" }));

import IntegrationDetailPage from "./[provider]/page";

describe("integration provider route feature gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: null, orgId: null, orgRole: null });
    mocks.custody.mockResolvedValue(false);
    mocks.payments.mockResolvedValue(false);
    mocks.policies.mockResolvedValue(false);
  });

  it.each(["privy", "moonpay", "range"])("404s disabled provider %s", async (provider) => {
    await expect(IntegrationDetailPage({ params: Promise.resolve({ provider }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("keeps RPC provider routes independent of product module flags", async () => {
    await expect(
      IntegrationDetailPage({ params: Promise.resolve({ provider: "helius" }) })
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.auth).toHaveBeenCalledOnce();
  });
});
