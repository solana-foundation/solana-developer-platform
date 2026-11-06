import { type ProjectIntegrations, projectIntegrationsSchema } from "@sdp/types/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import IntegrationsPage from "@/app/(session)/dashboard/[projectId]/integrations/(catalog)/page";
import * as flags from "@/flags";
import * as sdpApi from "@/lib/sdp-api";
import { SANDBOX_PROJECT } from "@/test/projects";
import { resetRequestProject, setPageRequest } from "@/test/request-project";

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test", orgId: "org_test" }),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

const INTEGRATIONS: ProjectIntegrations = {
  projectId: SANDBOX_PROJECT.id,
  environment: "sandbox",
  families: [
    {
      family: "custody",
      integrations: [
        {
          provider: "privy",
          category: "server",
          state: { status: "not_configured", modes: ["managed"] },
        },
      ],
    },
    {
      family: "private_channels",
      integrations: [
        { provider: "private_channels", state: { status: "not_configured", modes: ["managed"] } },
      ],
    },
  ],
};

/** Reads no answer covers; the page swallows some read errors, so each test checks this. */
const unexpectedPaths: string[] = [];

/** Answers the reads the page makes, and records any other so a new read is noticed. */
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

beforeEach(() => {
  unexpectedPaths.length = 0;
  resetRequestProject();
  setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/integrations`);
  // The member's SDP role comes from the API (`/v1/members/me`), not the Clerk session.
  vi.spyOn(sdpApi, "requestMemberRole").mockResolvedValue("admin");
  vi.spyOn(sdpApi, "createRequestScopedSdpApiClients").mockImplementation(async () => ({
    organizationClient: apiClient({
      "/v1/onboarding/status": { linked: true, organization: { id: "org_test" } },
    }),
    projectClient: apiClient({
      "/v1/integrations": INTEGRATIONS,
      "/v1/private-channels/instance": { instance: { isActive: true } },
    }),
  }));
});

afterEach(() => {
  expect(unexpectedPaths).toEqual([]);
  vi.restoreAllMocks();
});

describe("integrations catalog page", () => {
  it.each([true, false])(
    "keeps the Private Channels family only while the per-user flag is on (%s)",
    async (enabled) => {
      vi.spyOn(flags, "privateChannels").mockResolvedValue(enabled);

      const page = await IntegrationsPage();
      const { integrations } = z
        .object({ integrations: projectIntegrationsSchema })
        .parse(page.props);

      expect(integrations.families.map((family) => family.family)).toEqual(
        enabled ? ["custody", "private_channels"] : ["custody"]
      );
    }
  );
});
