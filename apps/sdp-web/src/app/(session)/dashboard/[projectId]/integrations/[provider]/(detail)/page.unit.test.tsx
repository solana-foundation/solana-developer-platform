import type { CustodyIntegration, ProjectIntegrations } from "@sdp/types/integrations";
import type { Project } from "@sdp/types/projects";
import { prerender } from "react-dom/static";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { resetRequestProject, setPageRequest } from "@/test/request-project";
import IntegrationDetailPage from "./page";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetchProjectProviderAvailability: vi.fn(),
  organizationFetch: vi.fn(),
  projectFetch: vi.fn(),
  projectRequest: vi.fn(),
  requestMemberRole: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/lib/provider-availability.server", () => ({
  fetchProjectProviderAvailability: mocks.fetchProjectProviderAvailability,
}));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createRequestScopedSdpApiClients: async () => ({
    organizationClient: { request: vi.fn(), fetch: mocks.organizationFetch },
    projectClient: { request: mocks.projectRequest, fetch: mocks.projectFetch },
  }),
  requestMemberRole: mocks.requestMemberRole,
}));

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
  const page = await IntegrationDetailPage({ params: Promise.resolve({ provider }) });
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
  mocks.auth.mockResolvedValue({ orgId: "org_test" });
  mocks.requestMemberRole.mockResolvedValue("viewer");
  mocks.organizationFetch.mockResolvedValue({ linked: true, organization: { id: "org_test" } });
  mocks.projectFetch.mockResolvedValue(
    projectIntegrations(PRODUCTION_PROJECT, [{ family: "custody", integrations: [PRIVY_BYOK] }])
  );
  mocks.projectRequest.mockRejectedValue(new Error("Unexpected request"));
  mocks.fetchProjectProviderAvailability.mockResolvedValue(
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

describe("IntegrationDetailPage", () => {
  it.each(["moonpay", "range"])(
    "404s %s, which has no provider page, before any read",
    async (provider) => {
      await expect(renderPage(provider)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mocks.auth).not.toHaveBeenCalled();
    }
  );

  it.each(READS_WITHOUT_TURNKEY)(
    "404s a provider the availability offers when the integrations read has %s",
    async (_case, families) => {
      mocks.projectFetch.mockResolvedValue(projectIntegrations(PRODUCTION_PROJECT, families));

      await expect(renderPage("turnkey")).rejects.toThrow("NEXT_NOT_FOUND");
    }
  );

  it("renders the Connected band for a Production project whose Privy is connected in byok mode", async () => {
    const markup = await renderPage("privy");

    expect(mocks.projectFetch.mock.calls).toEqual([["/v1/integrations"]]);
    expect(markup).toContain('data-integration-detail="privy"');
    expect(markup).toContain('data-state-band="ok"');
    expect(markup).toContain("Connected");
  });

  it("reads no connections for a custody provider whose modes leave out byok", async () => {
    setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/integrations/privy`);
    mocks.requestMemberRole.mockResolvedValue("admin");
    mocks.projectFetch.mockResolvedValue(
      projectIntegrations(SANDBOX_PROJECT, [
        {
          family: "custody",
          integrations: [{ ...PRIVY_BYOK, state: { status: "connected", mode: "managed" } }],
        },
      ])
    );
    mocks.fetchProjectProviderAvailability.mockResolvedValue(
      projectProviderAvailability({
        project: SANDBOX_PROJECT,
        custody: [{ provider: "privy", modes: ["managed"] }],
        compliance: [],
        ramps: [],
        earn: [],
      })
    );

    await renderPage("privy");

    expect(mocks.projectRequest).not.toHaveBeenCalled();
  });

  it("throws when the integrations read fails instead of rendering without it", async () => {
    mocks.projectFetch.mockRejectedValue(new Error("SDP API request failed (503): unavailable"));

    await expect(renderPage("privy")).rejects.toThrow("SDP API request failed (503): unavailable");
  });

  it("throws when the availability read fails instead of rendering without it", async () => {
    mocks.fetchProjectProviderAvailability.mockRejectedValue(
      new Error("SDP API request failed (503): unavailable")
    );

    await expect(renderPage("privy")).rejects.toThrow("SDP API request failed (503): unavailable");
  });
});
