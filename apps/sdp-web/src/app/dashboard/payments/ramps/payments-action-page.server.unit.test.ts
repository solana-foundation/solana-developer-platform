import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrgSdpApiClient: vi.fn(),
  createSdpApiClient: vi.fn(),
  fetchCounterparties: vi.fn(),
  fetchPaymentsIssuedTokenSymbols: vi.fn(),
  fetchProviderAvailability: vi.fn(),
  getEnabledRampProviders: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sdp-api", () => ({
  createOrgSdpApiClient: mocks.createOrgSdpApiClient,
  createSdpApiClient: mocks.createSdpApiClient,
}));
vi.mock("@/app/dashboard/payments/counterparty/counterparty-page.data", () => ({
  fetchCounterparties: mocks.fetchCounterparties,
}));
vi.mock("@/app/dashboard/payments/payments-page.data", () => ({
  fetchPaymentsIssuedTokenSymbols: mocks.fetchPaymentsIssuedTokenSymbols,
}));
vi.mock(import("@/lib/provider-availability"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchProviderAvailability: mocks.fetchProviderAvailability,
  };
});
vi.mock("@/flags/ramps", () => ({
  getEnabledRampProviders: mocks.getEnabledRampProviders,
}));

import { loadPaymentsActionPageData } from "./payments-action-page.server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("loadPaymentsActionPageData", () => {
  it("starts provider access as soon as onboarding resolves while sibling reads remain pending", async () => {
    const issuedTokens = deferred<{
      ok: true;
      data: Array<{ mintAddress: string; symbol: string }>;
    }>();
    const counterparties = deferred<{ ok: true; data: never[]; total: 0 }>();
    const orgRequest = vi.fn();
    const apiRequest = vi.fn();
    const counterpartiesResult = { ok: true as const, data: [], total: 0 as const };
    const providerAvailability = {
      enabledComplianceProviders: [],
      rampProviderAccess: {
        moonpay: { entitled: true, configured: true, enabled: true },
        mural: { entitled: true, configured: true, enabled: true },
        stripe: { entitled: true, configured: true, enabled: true },
      },
    };

    mocks.createOrgSdpApiClient.mockResolvedValue({
      fetch: vi.fn().mockResolvedValue({
        linked: true,
        organization: { id: "org_test" },
      }),
      request: orgRequest,
    });
    mocks.createSdpApiClient.mockResolvedValue({ request: apiRequest });
    mocks.fetchPaymentsIssuedTokenSymbols.mockReturnValue(issuedTokens.promise);
    mocks.fetchCounterparties.mockReturnValue(counterparties.promise);
    mocks.fetchProviderAvailability.mockResolvedValue(providerAvailability);
    mocks.getEnabledRampProviders.mockResolvedValue(["moonpay", "stripe"]);

    const resultPromise = loadPaymentsActionPageData();

    await vi.waitFor(() => {
      expect(mocks.fetchProviderAvailability).toHaveBeenCalledWith(orgRequest, "org_test");
    });
    expect(mocks.fetchPaymentsIssuedTokenSymbols).toHaveBeenCalledWith(apiRequest);
    expect(mocks.fetchCounterparties).toHaveBeenCalledWith(apiRequest);

    issuedTokens.resolve({
      ok: true,
      data: [{ mintAddress: "mint_usdc", symbol: "USDC" }],
    });
    counterparties.resolve(counterpartiesResult);

    await expect(resultPromise).resolves.toEqual({
      issuedTokenSymbolsByMint: { mint_usdc: "USDC" },
      enabledComplianceProviders: [],
      enabledRampProviders: ["moonpay", "stripe"],
      rampProviderAccess: {
        moonpay: { entitled: true, configured: true, enabled: true },
        stripe: { entitled: true, configured: true, enabled: true },
      },
      counterpartiesResult,
    });
  });
});
