import type { CustodyConfigStatus, CustodyProvider } from "@sdp/types/custody";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as providerAvailabilityServer from "@/lib/provider-availability.server";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { setPageRequest } from "@/test/request-project";

// The signed-in Organization, the one ambient input the page reads from Clerk.
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ orgId: "org_test" }) }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

import CustodySetupPage from "./page";
import { WalletSetupFlow } from "./wallet-setup-flow";

const organizationFetch = vi.fn();
const projectRequest = vi.fn<sdpApi.SdpApiClient["request"]>();
const fetchAvailability =
  vi.fn<typeof providerAvailabilityServer.fetchProjectProviderAvailability>();
const memberRole = vi.fn<typeof sdpApi.requestMemberRole>();

function config(provider: CustodyProvider, status: CustodyConfigStatus) {
  return {
    id: `cfg_${provider}`,
    organizationId: "org_test",
    projectId: PRODUCTION_PROJECT.id,
    provider,
    status,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  organizationFetch.mockReset().mockResolvedValue({
    linked: true,
    organization: { id: "org_test" },
  });
  projectRequest.mockReset().mockImplementation(async (path: string) => {
    if (path === "/v1/wallets/configs") {
      return Response.json({
        data: { configs: [config("privy", "active"), config("fireblocks", "archived")] },
      });
    }
    if (path.startsWith("/internal/dashboard/custody/connections?")) {
      return Response.json({
        data: { connections: [], pagination: { limit: 100, offset: 0, total: 0 } },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  fetchAvailability.mockReset();
  memberRole.mockReset().mockResolvedValue("admin");
  vi.spyOn(sdpApi, "createRequestScopedSdpApiClients").mockResolvedValue({
    organizationClient: { request: vi.fn(), fetch: organizationFetch },
    projectClient: { request: projectRequest, fetch: vi.fn() },
  });
  vi.spyOn(sdpApi, "requestMemberRole").mockImplementation(memberRole);
  vi.spyOn(providerAvailabilityServer, "fetchProjectProviderAvailability").mockImplementation(
    fetchAvailability
  );
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/setup`);
});

describe("custody setup page", () => {
  it("renders the flow from the project's custody availability and environment", async () => {
    fetchAvailability.mockResolvedValue(
      projectProviderAvailability({
        project: PRODUCTION_PROJECT,
        custody: [{ provider: "privy", modes: ["byok"] }],
        compliance: ["range"],
        ramps: ["moonpay"],
        earn: [],
      })
    );

    const page = await CustodySetupPage({ searchParams: Promise.resolve({ provider: "privy" }) });

    if (!isValidElement(page)) throw new Error("The page rendered no element");
    expect(page.type).toBe(WalletSetupFlow);
    expect(page.props).toEqual({
      // Only an active config counts as a provider the project already uses.
      connectedProviders: ["privy"],
      custodyAvailability: [
        {
          family: "custody",
          provider: "privy",
          modes: ["byok"],
          unavailableModes: [{ mode: "managed", reason: "custody_mode_not_allowed" }],
        },
      ],
      environment: "production",
      initialProvider: "privy",
      connections: [],
    });
  });

  it("throws when the availability read fails instead of rendering without it", async () => {
    fetchAvailability.mockRejectedValue(new Error("SDP API request failed (503): unavailable"));

    await expect(CustodySetupPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "SDP API request failed (503): unavailable"
    );
  });

  it("sends an Organization that is not linked yet to the wallets page", async () => {
    organizationFetch.mockResolvedValue({ linked: false, organization: null });

    await expect(CustodySetupPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      `NEXT_REDIRECT /dashboard/${PRODUCTION_PROJECT.id}/wallets`
    );
    expect(projectRequest).not.toHaveBeenCalled();
    expect(fetchAvailability).not.toHaveBeenCalled();
  });

  it.each([
    [{ provider: "privy" }, `/dashboard/${PRODUCTION_PROJECT.id}/integrations/privy`],
    [{}, `/dashboard/${PRODUCTION_PROJECT.id}/integrations`],
  ])("redirects a member given %o to %s before any API read", async (searchParams, destination) => {
    memberRole.mockResolvedValue("member");

    await expect(CustodySetupPage({ searchParams: Promise.resolve(searchParams) })).rejects.toThrow(
      `NEXT_REDIRECT ${destination}`
    );

    expect(organizationFetch).not.toHaveBeenCalled();
    expect(projectRequest).not.toHaveBeenCalled();
    expect(fetchAvailability).not.toHaveBeenCalled();
  });
});
