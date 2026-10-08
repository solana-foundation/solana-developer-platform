import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetchProjectProviderAvailability: vi.fn(),
  organizationFetch: vi.fn(),
  projectRequest: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/auth-entry", () => ({ getAuthEntryPath: async () => "/sign-in" }));
vi.mock("@/lib/provider-availability.server", () => ({
  fetchProjectProviderAvailability: mocks.fetchProjectProviderAvailability,
}));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createRequestScopedSdpApiClients: async () => ({
    organizationClient: { request: vi.fn(), fetch: mocks.organizationFetch },
    projectClient: { request: mocks.projectRequest, fetch: vi.fn() },
  }),
}));
vi.mock("@/app/dashboard/[projectId]/custody/actions", () => ({
  createCustodySetupWalletAction: vi.fn(),
  initializeCustodySetupAction: vi.fn(),
}));

import CustodySetupPage from "./page";
import { WalletSetupFlow } from "./wallet-setup-flow";

describe("custody setup page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
    mocks.organizationFetch.mockResolvedValue({
      linked: true,
      organization: { id: "org_test" },
    });
    mocks.projectRequest.mockImplementation(async (path: string) => {
      if (path === "/v1/wallets/configs") {
        return Response.json({ data: { configs: [] } });
      }
      if (path.startsWith("/internal/dashboard/custody/connections?")) {
        return Response.json({
          data: { connections: [], pagination: { limit: 100, offset: 0, total: 0 } },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it("renders the flow from the project's custody availability and environment", async () => {
    mocks.fetchProjectProviderAvailability.mockResolvedValue(
      projectProviderAvailability({
        project: PRODUCTION_PROJECT,
        custody: [{ provider: "privy", modes: ["byok"] }],
        compliance: ["range"],
        ramps: ["moonpay"],
        earn: [],
      })
    );

    const page = await CustodySetupPage({ searchParams: Promise.resolve({ provider: "privy" }) });

    expect(page.type).toBe(WalletSetupFlow);
    expect(page.props).toEqual({
      connectedProviders: [],
      custodyAvailability: [{ family: "custody", provider: "privy", modes: ["byok"] }],
      environment: "production",
      initialProvider: "privy",
      connections: [],
    });
  });

  it("throws when the availability read fails instead of rendering without it", async () => {
    mocks.fetchProjectProviderAvailability.mockRejectedValue(
      new Error("SDP API request failed (503): unavailable")
    );

    await expect(CustodySetupPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "SDP API request failed (503): unavailable"
    );
  });
});
