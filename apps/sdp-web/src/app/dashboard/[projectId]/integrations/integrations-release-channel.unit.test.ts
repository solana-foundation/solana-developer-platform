import { COMPLIANCE_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types/provider-access";
import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNEL_NAMES,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rampProvidersInReleaseChannel } from "@/flags/release-channel";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { dashboardFlagsAt } from "@/test/release-channel-flags";
import { integrationsSkeletonLayout } from "./integration-feature-gates";

const channel = vi.hoisted(() => ({ current: "stable" as SdpReleaseChannel }));
const mocks = vi.hoisted(() => ({
  fetchProjectProviderAvailability: vi.fn(),
  organizationFetch: vi.fn(),
  projectRequest: vi.fn(),
  projectFetch: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" }),
}));
vi.mock("server-only", () => ({}));
// Each flag read as the shell's snapshot would serve it with Vercel serving every flag on.
vi.mock("@/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/flags")>()),
  privateChannels: async () => dashboardFlagsAt(channel.current).privateChannels,
}));
vi.mock("@/flags/ramps", () => ({
  getOfferedRampProviders: async () =>
    dashboardFlagsAt(channel.current).ramps ? rampProvidersInReleaseChannel(channel.current) : [],
}));
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/auth-entry", () => ({ getAuthEntryPath: async () => "/sign-in" }));
vi.mock("@/lib/provider-availability.server", () => ({
  fetchProjectProviderAvailability: mocks.fetchProjectProviderAvailability,
}));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createRequestScopedSdpApiClients: async () => ({
    organizationClient: { request: vi.fn(), fetch: mocks.organizationFetch },
    projectClient: { request: mocks.projectRequest, fetch: mocks.projectFetch },
  }),
}));

import IntegrationDetailPage from "./[provider]/page";
import IntegrationsPage from "./page";

function useChannel(releaseChannel: SdpReleaseChannel) {
  channel.current = releaseChannel;
  // The compliance gate reads the deployment's channel itself.
  vi.stubEnv("SDP_RELEASE_CHANNEL", releaseChannel);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.organizationFetch.mockResolvedValue({ linked: true, organization: { id: "org_test" } });
  mocks.projectRequest.mockImplementation(async (path: string) => {
    if (path === "/v1/wallets/configs") return Response.json({ data: { configs: [] } });
    throw new Error(`Unexpected request: ${path}`);
  });
  mocks.projectFetch.mockResolvedValue({ instance: { isActive: true } });
  // The Project may use every provider, so the release channel is the only gate left.
  mocks.fetchProjectProviderAvailability.mockResolvedValue(
    projectProviderAvailability({
      project: SANDBOX_PROJECT,
      custody: [{ provider: "privy", modes: ["managed"] }],
      compliance: [...COMPLIANCE_PROVIDERS],
      ramps: [...RAMP_PROVIDERS],
      earn: [],
    })
  );
});

describe("integrations catalog on each release channel", () => {
  it.each(SDP_RELEASE_CHANNEL_NAMES)(
    "lists only %s's families, as its skeleton reserves",
    async (releaseChannel) => {
      useChannel(releaseChannel);
      const { families, rampCards } = integrationsSkeletonLayout(dashboardFlagsAt(releaseChannel));

      const { props } = await IntegrationsPage();

      expect(props.enabledFamilies).toEqual(families);
      expect(props.ramps).toHaveLength(rampCards);
      expect(props.compliance.length > 0).toBe(families.includes("compliance"));
      expect(props.privacy.length > 0).toBe(families.includes("privacy"));
    }
  );
});

describe("integration detail deep links on each release channel", () => {
  it.each(SDP_RELEASE_CHANNEL_NAMES)(
    "opens a ramp or compliance provider's page only where %s runs it",
    async (releaseChannel) => {
      useChannel(releaseChannel);
      const offered = rampProvidersInReleaseChannel(releaseChannel);
      const compliance = isModuleInReleaseChannel(
        releaseChannel,
        "compliance",
        SDP_RAMP_PROVIDER_STAGES
      );
      const expectations = [
        ...RAMP_PROVIDERS.map((provider) => [provider, offered.includes(provider)] as const),
        ...COMPLIANCE_PROVIDERS.map((provider) => [provider, compliance] as const),
      ];

      for (const [provider, opens] of expectations) {
        const page = IntegrationDetailPage({ params: Promise.resolve({ provider }) });
        if (opens) {
          await expect(page, provider).resolves.toBeDefined();
        } else {
          await expect(page, provider).rejects.toThrow("NEXT_NOT_FOUND");
        }
      }
    }
  );

  it("opens a custody provider on stable, its Capabilities trimmed to stable", async () => {
    useChannel("stable");
    const page = await IntegrationDetailPage({ params: Promise.resolve({ provider: "privy" }) });
    // The view drops each Capability whose module the channel leaves out.
    expect(page.props.releaseChannel).toBe("stable");
  });
});
