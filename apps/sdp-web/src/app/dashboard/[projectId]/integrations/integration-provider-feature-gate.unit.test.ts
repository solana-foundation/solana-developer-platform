import { beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  custody: vi.fn(),
  rampProviders: vi.fn(),
  payments: vi.fn(),
  complianceInChannel: vi.fn(),
  fetchProjectProviderAvailability: vi.fn(),
  organizationFetch: vi.fn(),
  projectRequest: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("server-only", () => ({}));
vi.mock("@/flags", () => ({
  custody: mocks.custody,
  payments: mocks.payments,
}));
vi.mock("@/flags/release-channel", () => ({
  isModuleInDeploymentReleaseChannel: (module: string) =>
    module === "compliance" && mocks.complianceInChannel(),
}));
vi.mock("@/flags/ramps", () => ({ getOfferedRampProviders: mocks.rampProviders }));
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

import IntegrationDetailPage from "./[provider]/page";

describe("integration provider route feature gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: null, orgId: null, orgRole: null });
    mocks.custody.mockResolvedValue(false);
    mocks.rampProviders.mockResolvedValue([]);
    mocks.payments.mockResolvedValue(false);
    mocks.complianceInChannel.mockReturnValue(false);
  });

  it.each(["privy", "moonpay", "range"])("404s disabled provider %s", async (provider) => {
    await expect(IntegrationDetailPage({ params: Promise.resolve({ provider }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("404s a ramp provider the channel leaves out while another ramp is offered", async () => {
    mocks.rampProviders.mockResolvedValue(["moonpay"]);

    await expect(
      IntegrationDetailPage({ params: Promise.resolve({ provider: "lightspark" }) })
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});

describe("integration provider route availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" });
    mocks.custody.mockResolvedValue(true);
    mocks.rampProviders.mockResolvedValue(["moonpay", "bvnk"]);
    mocks.payments.mockResolvedValue(true);
    mocks.complianceInChannel.mockReturnValue(true);
    mocks.organizationFetch.mockResolvedValue({
      linked: true,
      organization: { id: "org_test" },
    });
    mocks.projectRequest.mockImplementation(async (path: string) => {
      if (path === "/v1/wallets/configs") {
        return Response.json({ data: { configs: [] } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    mocks.fetchProjectProviderAvailability.mockResolvedValue(
      projectProviderAvailability({
        project: SANDBOX_PROJECT,
        custody: [{ provider: "privy", modes: ["managed"] }],
        compliance: ["range"],
        ramps: ["moonpay"],
        earn: [],
      })
    );
  });

  it.each(["turnkey", "bvnk", "trm"])(
    "404s provider %s the project cannot use",
    async (provider) => {
      await expect(
        IntegrationDetailPage({ params: Promise.resolve({ provider }) })
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mocks.fetchProjectProviderAvailability).toHaveBeenCalledTimes(1);
    }
  );

  it("renders an available provider's detail", async () => {
    const page = await IntegrationDetailPage({ params: Promise.resolve({ provider: "moonpay" }) });

    expect(page.props.detail).toMatchObject({
      family: "ramps",
      provider: "moonpay",
      status: "enabled",
    });
  });

  it("reads no connections for a custody provider whose modes leave out byok", async () => {
    const page = await IntegrationDetailPage({ params: Promise.resolve({ provider: "privy" }) });

    expect(page.props.detail).toMatchObject({ family: "custody", provider: "privy" });
    expect(page.props.custodyConnections).toBeNull();
    expect(mocks.projectRequest.mock.calls).toEqual([["/v1/wallets/configs"]]);
  });

  it("throws when the availability read fails instead of rendering without it", async () => {
    mocks.fetchProjectProviderAvailability.mockRejectedValue(
      new Error("SDP API request failed (503): unavailable")
    );

    await expect(
      IntegrationDetailPage({ params: Promise.resolve({ provider: "moonpay" }) })
    ).rejects.toThrow("SDP API request failed (503): unavailable");
  });

  it("throws when the custody config read fails instead of rendering an unknown status", async () => {
    mocks.projectRequest.mockResolvedValue(new Response("configs unavailable", { status: 503 }));

    await expect(
      IntegrationDetailPage({ params: Promise.resolve({ provider: "privy" }) })
    ).rejects.toThrow("SDP API request failed (503): configs unavailable");
  });
});
