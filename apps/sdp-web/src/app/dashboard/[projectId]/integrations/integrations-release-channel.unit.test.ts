import { COMPLIANCE_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types/provider-access";
import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_MATURITY,
  SDP_RELEASE_CHANNEL_NAMES,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IntegrationDetailPage from "@/app/dashboard/[projectId]/integrations/[provider]/page";
import { integrationsSkeletonLayout } from "@/app/dashboard/[projectId]/integrations/integration-feature-gates";
import IntegrationsPage from "@/app/dashboard/[projectId]/integrations/page";
import * as flags from "@/flags";
import * as ramps from "@/flags/ramps";
import { rampProvidersInReleaseChannel } from "@/flags/release-channel";
import * as sdpApi from "@/lib/sdp-api";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { dashboardFlagsAt } from "@/test/release-channel-flags";
import { resetRequestProject, setPageRequest } from "@/test/request-project";

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test", orgId: "org_test", orgRole: "org:admin" }),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

// The Project may use every provider, so the release channel is the only gate left.
const AVAILABILITY = projectProviderAvailability({
  project: SANDBOX_PROJECT,
  custody: [{ provider: "privy", modes: ["managed"] }],
  compliance: [...COMPLIANCE_PROVIDERS],
  ramps: [...RAMP_PROVIDERS],
  earn: [],
});

/** Reads no answer covers; the pages swallow some read errors, so each test checks this. */
const unexpectedPaths: string[] = [];

/** Answers the reads both pages make, and records any other so a new read is noticed. */
function apiClient(answers: Record<string, unknown>): sdpApi.SdpApiClient {
  const answer = (path: string) => {
    if (!(path in answers)) {
      unexpectedPaths.push(path);
      throw new Error(`Unexpected request: ${path}`);
    }
    return answers[path];
  };
  return {
    request: async (path: string) => Response.json(answer(path)),
    // SAFETY: each answer is the body the API returns for that path.
    fetch: async <T>(path: string): Promise<T> => answer(path) as T,
  };
}

function useChannel(releaseChannel: SdpReleaseChannel) {
  // The page reads the channel itself; the flags it reads are capped at it.
  vi.stubEnv("SDP_RELEASE_CHANNEL", releaseChannel);
  const snapshot = dashboardFlagsAt(releaseChannel);
  vi.spyOn(flags, "privateChannels").mockResolvedValue(snapshot.privateChannels);
  vi.spyOn(ramps, "getOfferedRampProviders").mockResolvedValue(
    snapshot.ramps ? rampProvidersInReleaseChannel(releaseChannel) : []
  );
}

beforeEach(() => {
  unexpectedPaths.length = 0;
  resetRequestProject();
  setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/integrations`);
  vi.spyOn(sdpApi, "createRequestScopedSdpApiClients").mockImplementation(async () => ({
    organizationClient: apiClient({
      "/v1/onboarding/status": { linked: true, organization: { id: "org_test" } },
    }),
    projectClient: apiClient({
      [`/v1/projects/${SANDBOX_PROJECT.id}/provider-availability`]: AVAILABILITY,
      "/v1/wallets/configs": { data: { configs: [] } },
      "/v1/private-channels/instance": { instance: { isActive: true } },
    }),
  }));
});

afterEach(() => {
  expect(unexpectedPaths).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    "opens a provider's page only where %s runs it",
    async (releaseChannel) => {
      useChannel(releaseChannel);
      const offered = rampProvidersInReleaseChannel(releaseChannel);
      const compliance = isModuleInReleaseChannel(
        releaseChannel,
        "compliance",
        SDP_RAMP_PROVIDER_MATURITY
      );
      const expectations = [
        ["privy", isModuleInReleaseChannel(releaseChannel, "custody", SDP_RAMP_PROVIDER_MATURITY)],
        ...RAMP_PROVIDERS.map((provider) => [provider, offered.includes(provider)] as const),
        ...COMPLIANCE_PROVIDERS.map((provider) => [provider, compliance] as const),
      ] as const;

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
});
