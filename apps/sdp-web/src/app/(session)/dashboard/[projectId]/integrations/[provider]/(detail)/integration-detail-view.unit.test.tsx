import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_MATURITY,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIntegrationDetail } from "@/app/(session)/dashboard/[projectId]/integrations/integration-detail";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
} from "@/app/(session)/dashboard/[projectId]/integrations/integrations-status";
import {
  type CustodyConnectionListItem,
  summarizeProviderConnections,
} from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections.data";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  availableComplianceProviders,
  availableCustodyProviders,
  availableRampProviders,
} from "@/lib/provider-availability";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { resetRequestProject, setPageRequest } from "@/test/request-project";
import { type CustodyConnectionsContext, IntegrationDetailView } from "./integration-detail-view";

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock(
  "@/app/(session)/dashboard/[projectId]/wallets/connections/use-selected-project-name",
  () => ({ useSelectedProjectName: () => "Acme Payments" })
);

const PROJECT_PATH = `/dashboard/${SANDBOX_PROJECT.id}`;

const AVAILABILITY = projectProviderAvailability({
  project: SANDBOX_PROJECT,
  custody: [
    { provider: "privy", modes: ["managed", "byok"] },
    { provider: "para", modes: ["managed"] },
    { provider: "fireblocks", modes: ["managed", "byok"] },
    { provider: "anchorage", modes: ["managed"] },
  ],
  compliance: ["range"],
  ramps: ["moonpay"],
  earn: [],
});

const INPUTS = {
  custody: resolveCustodyIntegrations({
    connectedProviders: ["privy"],
    custodyAvailability: availableCustodyProviders(AVAILABILITY),
  }),
  ramps: resolveRampIntegrations(availableRampProviders(AVAILABILITY), RAMP_PROVIDERS),
  compliance: resolveComplianceIntegrations(availableComplianceProviders(AVAILABILITY)),
};

function makeConnection(id: string, isRuntimeExecutionAllowed: boolean): CustodyConnectionListItem {
  return {
    id,
    provider: "privy",
    label: "Treasury signing",
    status: "active",
    isRuntimeExecutionAllowed,
    createdAt: "2026-08-10T09:00:00.000Z",
    activatedAt: "2026-08-10T09:05:00.000Z",
    lastCheck: { status: "success", at: "2026-08-10T09:05:00.000Z", failureCode: null },
    pendingWalletLabel: null,
  };
}

async function render({
  provider,
  releaseChannel,
  canManageCustody,
  custodyConnections,
}: {
  provider: string;
  releaseChannel: SdpReleaseChannel;
  canManageCustody: boolean;
  custodyConnections: CustodyConnectionsContext;
}): Promise<string> {
  const detail = resolveIntegrationDetail({ provider, ...INPUTS });
  if (!detail) throw new Error(`unknown provider ${provider}`);
  vi.stubEnv("SDP_RELEASE_CHANNEL", releaseChannel);
  const { prelude } = await prerender(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <IntegrationDetailView
        detail={detail}
        custodyConnections={custodyConnections}
        canManageCustody={canManageCustody}
      />
    </I18nProvider>
  );
  return new Response(prelude).text();
}

function renderWithoutConnections(provider: string, canManageCustody: boolean): Promise<string> {
  return render({
    provider,
    releaseChannel: "experimental",
    canManageCustody,
    custodyConnections: null,
  });
}

function recordLine(markup: string, label: string): string | null {
  const match = new RegExp(`>${label}(?:(?!</dt>).)*</dt><dd[^>]*>(.*?)</dd>`).exec(markup);
  return match ? match[1].replace(/<[^>]+>/g, "") : null;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  resetRequestProject();
  setPageRequest(`${PROJECT_PATH}/integrations/privy`);
});

describe("IntegrationDetailView", () => {
  it("gives a connected custody provider without a connections list a manage action", async () => {
    const markup = await renderWithoutConnections("privy", true);
    expect(markup).toContain('data-state-band="ok"');
    expect(markup).toContain("Connected");
    expect(markup).toContain(`href="${PROJECT_PATH}/wallets"`);
    expect(markup).toContain("Manage");
  });

  it("routes an available custody provider into setup", async () => {
    const markup = await renderWithoutConnections("para", true);
    expect(markup).toContain('data-state-band="neutral"');
    expect(markup).toContain("Ready to connect");
    expect(markup).toContain(`${PROJECT_PATH}/wallets/setup?provider=para`);
  });

  it("offers no setup action to a member who cannot manage custody", async () => {
    const markup = await renderWithoutConnections("para", false);
    expect(markup).toContain("Ready to connect");
    expect(markup).not.toContain("/wallets/setup");
  });

  it("says a manual provider is set up by the SDP team, by arrangement", async () => {
    const markup = await renderWithoutConnections("anchorage", true);
    expect(markup).toContain(`${PROJECT_PATH}/wallets/setup?provider=anchorage`);
    expect(recordLine(markup, "Set up by")).toBe("The SDP team, by arrangement");
    expect(markup).toContain("Available by arrangement");
  });

  it.each([
    ["moonpay", "Ramps"],
    ["range", "Compliance"],
  ])("shows %s as enabled by the operator, with no action", async (provider, family) => {
    const markup = await renderWithoutConnections(provider, true);
    expect(markup).toContain("Enabled");
    expect(markup).not.toContain("Manage");
    expect(markup).not.toContain("/wallets/setup");
    expect(recordLine(markup, "Family")).toBe(family);
    expect(recordLine(markup, "Kind")).toBeNull();
    expect(recordLine(markup, "Set up by")).toBe("Your SDP operator");
    expect(markup).toContain("Provisioned per deployment");
  });

  it("puts the signing count in the band and the list below it, with no band action", async () => {
    const signing = makeConnection("conn_test_a91c", true);
    const markup = await render({
      provider: "privy",
      releaseChannel: "experimental",
      canManageCustody: true,
      custodyConnections: {
        result: { connections: [signing], pagination: { limit: 20, offset: 0, total: 2 } },
        filters: { page: 1 },
        summary: summarizeProviderConnections({
          connections: [signing, makeConnection("conn_test_b72d", false)],
          complete: true,
        }),
        walletsByConnection: {},
        walletsUnavailable: false,
      },
    });
    expect(markup).toContain("1 of 2 connections can sign in Acme Payments.");
    expect(markup).toContain('data-connection-id="conn_test_a91c"');
    expect(markup).not.toContain(`href="${PROJECT_PATH}/wallets"`);
  });

  it("tells a viewer who cannot read connections why, without a band action", async () => {
    const markup = await render({
      provider: "privy",
      releaseChannel: "experimental",
      canManageCustody: false,
      custodyConnections: "restricted",
    });
    expect(markup).toContain("You can view connections in this project.");
    expect(markup).not.toContain("data-connection-id");
    expect(markup).not.toContain(`href="${PROJECT_PATH}/wallets"`);
  });

  it("details a self-service provider's credentials without the name or scope fields", async () => {
    const markup = await renderWithoutConnections("privy", true);
    expect(recordLine(markup, "Family")).toBe("Custody");
    expect(recordLine(markup, "Kind")).toBe("API");
    expect(recordLine(markup, "Set up by")).toBe("You, with your Privy app");
    expect(recordLine(markup, "App ID")).toBe("From your Privy dashboard");
    expect(recordLine(markup, "App secret")).toBe("Write-only, never shown again");
    expect(recordLine(markup, "Connection name")).toBeNull();
    expect(recordLine(markup, "Credential scope")).toBeNull();
    expect(recordLine(markup, "Resources")).toBe("View documentation");
  });

  it("lists no use whose module the release channel leaves out", async () => {
    const labels = getMessages("en").DashboardCustody;
    const usesOn = async (releaseChannel: SdpReleaseChannel) => {
      const markup = await render({
        provider: "privy",
        releaseChannel,
        canManageCustody: true,
        custodyConnections: null,
      });
      const uses = recordLine(markup, "Used for");
      if (uses === null) throw new Error(`no uses on ${releaseChannel}`);
      return uses.split(", ");
    };

    expect(await usesOn("experimental")).toEqual(
      expect.arrayContaining([labels.issuance, labels.transfers, labels.compliance])
    );
    const stable = await usesOn("stable");
    expect(stable).toContain(labels.transfers);
    for (const module of ["issuance", "compliance"] as const) {
      expect(stable.includes(labels[module]), module).toBe(
        isModuleInReleaseChannel("stable", module, SDP_RAMP_PROVIDER_MATURITY)
      );
    }
  });
});
