import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  custody: vi.fn(),
  ramps: vi.fn(),
  payments: vi.fn(),
  policies: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("server-only", () => ({}));
vi.mock("@/flags", () => ({
  custody: mocks.custody,
  payments: mocks.payments,
  policies: mocks.policies,
}));
vi.mock("@/flags/ramps", () => ({ isRampsEnabled: mocks.ramps }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/auth-entry", () => ({ getAuthEntryPath: async () => "/sign-in" }));

import IntegrationDetailPage from "./[provider]/page";

describe("integration provider route feature gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: null, orgId: null, orgRole: null });
    mocks.custody.mockResolvedValue(false);
    mocks.ramps.mockResolvedValue(false);
    mocks.payments.mockResolvedValue(false);
    mocks.policies.mockResolvedValue(false);
  });

  it.each(["privy", "moonpay", "range"])("404s disabled provider %s", async (provider) => {
    await expect(IntegrationDetailPage({ params: Promise.resolve({ provider }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
