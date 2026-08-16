import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetchActiveApiKeys: vi.fn(),
  fetchProviderAvailability: vi.fn(),
  organizationFetch: vi.fn(),
  projectRequest: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirected to ${path}`);
  }),
}));
vi.mock("@/lib/auth-entry", () => ({ getAuthEntryPath: vi.fn(async () => "/sign-in") }));
vi.mock("@/app/dashboard/playground-api-data", () => ({
  fetchActiveApiKeys: mocks.fetchActiveApiKeys,
  resolvePlaygroundApiBaseUrl: () => "https://api.example.test",
}));
vi.mock("@/lib/provider-availability", () => ({
  fetchProviderAvailability: mocks.fetchProviderAvailability,
}));
vi.mock("@/lib/sdp-api", () => ({
  createRequestScopedSdpApiClients: vi.fn(async () => ({
    organizationClient: { fetch: mocks.organizationFetch },
    projectClient: { request: mocks.projectRequest },
  })),
}));
vi.mock("./earn-workspace", () => ({
  EarnWorkspace: ({
    apiKeys,
    fireblocksEnabled,
  }: {
    apiKeys: readonly unknown[];
    fireblocksEnabled: boolean;
  }) => (
    <div data-api-key-count={apiKeys.length} data-fireblocks-enabled={String(fireblocksEnabled)} />
  ),
}));

import EarnPage from "./page";

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.fetchActiveApiKeys.mockReset();
  mocks.fetchProviderAvailability.mockReset();
  mocks.organizationFetch.mockReset();
  mocks.projectRequest.mockReset();

  mocks.auth.mockResolvedValue({ userId: "user_one", orgId: "org_clerk_one" });
  mocks.fetchActiveApiKeys.mockResolvedValue({
    ok: true,
    data: [{ id: "key_one", name: "Sandbox", keyPrefix: "sdp_", environment: "sandbox" }],
  });
  mocks.organizationFetch.mockResolvedValue({
    linked: true,
    organization: { id: "org_sdp_one" },
  });
  mocks.fetchProviderAvailability.mockResolvedValue({
    enabledCustodyProviders: ["fireblocks"],
  });
});

describe("EarnPage provider availability", () => {
  it("uses the linked SDP organization id instead of Clerk's id", async () => {
    const markup = renderToStaticMarkup(await EarnPage());

    expect(mocks.organizationFetch).toHaveBeenCalledWith("/v1/onboarding/status");
    expect(mocks.fetchProviderAvailability).toHaveBeenCalledWith(
      mocks.projectRequest,
      "org_sdp_one"
    );
    expect(mocks.fetchProviderAvailability).not.toHaveBeenCalledWith(
      mocks.projectRequest,
      "org_clerk_one"
    );
    expect(markup).toContain('data-fireblocks-enabled="true"');
  });

  it("keeps API-key context when provider availability is unavailable", async () => {
    mocks.fetchProviderAvailability.mockRejectedValue(new Error("provider access unavailable"));

    const markup = renderToStaticMarkup(await EarnPage());

    expect(markup).toContain('data-api-key-count="1"');
    expect(markup).toContain('data-fireblocks-enabled="false"');
  });

  it("keeps API-key context when onboarding lookup is unavailable", async () => {
    mocks.organizationFetch.mockRejectedValue(new Error("onboarding unavailable"));

    const markup = renderToStaticMarkup(await EarnPage());

    expect(markup).toContain('data-api-key-count="1"');
    expect(markup).toContain('data-fireblocks-enabled="false"');
  });
});
