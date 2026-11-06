import type { CustodyIntegration, ProjectIntegrations } from "@sdp/types/integrations";
import type { Project } from "@sdp/types/projects";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import * as providerAvailability from "@/lib/provider-availability.server";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { resetRequestProject, setPageRequest } from "@/test/request-project";
import IntegrationDetailPage from "./page";

const auth = vi.hoisted(() => vi.fn());

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

const organizationFetch = vi.fn();
const projectFetch = vi.fn();
const projectRequest = vi.fn();

const PRIVY_BYOK: CustodyIntegration = {
  provider: "privy",
  category: "server",
  state: { status: "connected", mode: "byok" },
};

const READS_WITHOUT_TURNKEY: ReadonlyArray<[string, ProjectIntegrations["families"]]> = [
  ["a custody family without it", [{ family: "custody", integrations: [PRIVY_BYOK] }]],
  [
    "no custody family",
    [
      {
        family: "private_channels",
        integrations: [
          { provider: "private_channels", state: { status: "not_configured", modes: ["managed"] } },
        ],
      },
    ],
  ],
];

function projectIntegrations(
  project: Project,
  families: ProjectIntegrations["families"]
): ProjectIntegrations {
  return { projectId: project.id, environment: project.environment, families };
}

async function renderPage(provider: string): Promise<string> {
  const page = await IntegrationDetailPage({
    params: Promise.resolve({ provider }),
    searchParams: Promise.resolve({}),
  });
  const { prelude } = await prerender(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {page}
    </I18nProvider>
  );
  return new Response(prelude).text();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRequestProject();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/integrations/privy`);
  auth.mockResolvedValue({ orgId: "org_test" });
  vi.spyOn(sdpApi, "requestMemberRole").mockResolvedValue("viewer");
  vi.spyOn(sdpApi, "createRequestScopedSdpApiClients").mockImplementation(async () => ({
    organizationClient: { request: vi.fn(), fetch: organizationFetch },
    projectClient: { request: projectRequest, fetch: projectFetch },
  }));
  organizationFetch.mockResolvedValue({ linked: true, organization: { id: "org_test" } });
  projectFetch.mockResolvedValue(
    projectIntegrations(PRODUCTION_PROJECT, [{ family: "custody", integrations: [PRIVY_BYOK] }])
  );
  projectRequest.mockRejectedValue(new Error("Unexpected request"));
  vi.spyOn(providerAvailability, "fetchProjectProviderAvailability").mockResolvedValue(
    projectProviderAvailability({
      project: PRODUCTION_PROJECT,
      custody: [
        { provider: "privy", modes: ["byok"] },
        { provider: "turnkey", modes: ["byok"] },
      ],
      compliance: ["range"],
      ramps: ["moonpay"],
      earn: [],
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IntegrationDetailPage", () => {
  it.each(["moonpay", "range"])(
    "404s %s, which has no provider page, before any read",
    async (provider) => {
      await expect(renderPage(provider)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(auth).not.toHaveBeenCalled();
    }
  );

  it.each(READS_WITHOUT_TURNKEY)(
    "404s a provider the availability offers when the integrations read has %s",
    async (_case, families) => {
      projectFetch.mockResolvedValue(projectIntegrations(PRODUCTION_PROJECT, families));

      await expect(renderPage("turnkey")).rejects.toThrow("NEXT_NOT_FOUND");
    }
  );

  it("renders the Connected band for a Production project whose Privy is connected in byok mode", async () => {
    const markup = await renderPage("privy");

    expect(projectFetch.mock.calls).toEqual([["/v1/integrations"]]);
    expect(markup).toContain('data-integration-detail="privy"');
    expect(markup).toContain('data-state-band="ok"');
    expect(markup).toContain("Connected");
  });

  it("reads no connections for a custody provider whose modes leave out byok", async () => {
    setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/integrations/privy`);
    vi.spyOn(sdpApi, "requestMemberRole").mockResolvedValue("admin");
    projectFetch.mockResolvedValue(
      projectIntegrations(SANDBOX_PROJECT, [
        {
          family: "custody",
          integrations: [{ ...PRIVY_BYOK, state: { status: "connected", mode: "managed" } }],
        },
      ])
    );
    vi.spyOn(providerAvailability, "fetchProjectProviderAvailability").mockResolvedValue(
      projectProviderAvailability({
        project: SANDBOX_PROJECT,
        custody: [{ provider: "privy", modes: ["managed"] }],
        compliance: [],
        ramps: [],
        earn: [],
      })
    );

    await renderPage("privy");

    expect(projectRequest).not.toHaveBeenCalled();
  });

  it("throws when the integrations read fails instead of rendering without it", async () => {
    projectFetch.mockRejectedValue(new Error("SDP API request failed (503): unavailable"));

    await expect(renderPage("privy")).rejects.toThrow("SDP API request failed (503): unavailable");
  });

  it("throws when the availability read fails instead of rendering without it", async () => {
    vi.spyOn(providerAvailability, "fetchProjectProviderAvailability").mockRejectedValue(
      new Error("SDP API request failed (503): unavailable")
    );

    await expect(renderPage("privy")).rejects.toThrow("SDP API request failed (503): unavailable");
  });
});
