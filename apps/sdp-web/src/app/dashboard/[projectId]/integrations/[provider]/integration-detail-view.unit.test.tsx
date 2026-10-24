import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_MATURITY,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIntegrationDetail } from "@/app/dashboard/[projectId]/integrations/integration-detail";
import { IntegrationDetailSkeleton } from "@/app/dashboard/[projectId]/integrations/integrations-skeleton";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
} from "@/app/dashboard/[projectId]/integrations/integrations-status";
import { getMessages } from "@/i18n/messages";
import {
  availableComplianceProviders,
  availableCustodyProviders,
  availableRampProviders,
} from "@/lib/provider-availability";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { resetRequestProject, setPageRequest } from "@/test/request-project";
import { IntegrationDetailView } from "./integration-detail-view";

vi.mock("next/headers", () => import("@/test/next-headers"));

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

async function markupOf(node: ReactNode): Promise<string> {
  const { prelude } = await prerender(node);
  return new Response(prelude).text();
}

async function render(
  provider: string,
  releaseChannel: SdpReleaseChannel = "experimental"
): Promise<string> {
  const detail = resolveIntegrationDetail({ provider, ...INPUTS });
  if (!detail) throw new Error(`unknown provider ${provider}`);
  // The Capabilities read the deployment's release channel themselves.
  vi.stubEnv("SDP_RELEASE_CHANNEL", releaseChannel);
  return markupOf(<IntegrationDetailView detail={detail} />);
}

/** The Capabilities section's chips, by visible label. */
function capabilityChips(markup: string): string[] {
  return [...markup.matchAll(/<li class="rounded-full[^"]*">([^<]*)<\/li>/g)].map(
    ([, label]) => label
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  resetRequestProject();
  setPageRequest(`${PROJECT_PATH}/integrations/privy`);
});

describe("IntegrationDetailView", () => {
  it("gives a connected custody provider a manage action", async () => {
    const markup = await render("privy");
    expect(markup).toContain("Connected");
    expect(markup).toContain(`href="${PROJECT_PATH}/wallets"`);
    expect(markup).toContain("Manage");
  });

  it("routes an available custody provider into setup", async () => {
    const markup = await render("para");
    expect(markup).toContain("Ready to connect");
    expect(markup).toContain(`${PROJECT_PATH}/wallets/setup?provider=para`);
  });

  it("routes an available manual provider into setup and says it is by arrangement", async () => {
    const markup = await render("anchorage");
    expect(markup).toContain("Ready to connect");
    expect(markup).toContain(`${PROJECT_PATH}/wallets/setup?provider=anchorage`);
    expect(markup).toContain("Available by arrangement");
  });

  it("always says how a non-custody provider connects", async () => {
    const ramp = await render("moonpay");
    expect(ramp).toContain("Enabled");
    expect(ramp).toContain("Provisioned per deployment");

    const compliance = await render("range");
    expect(compliance).toContain("Enabled");
    expect(compliance).toContain("Provisioned per deployment");
  });

  it("advertises no capability whose module the release channel leaves out", async () => {
    // Privy lists Issuance and Compliance; the chips outlived the modules on stable (HOO-1977).
    const labels = getMessages("en").DashboardCustody;
    expect(capabilityChips(await render("privy"))).toEqual(
      expect.arrayContaining([labels.issuance, labels.transfers, labels.compliance])
    );

    const stable = capabilityChips(await render("privy", "stable"));
    expect(stable).toContain(labels.transfers);
    for (const module of ["issuance", "compliance"] as const) {
      expect(stable.includes(labels[module]), module).toBe(
        isModuleInReleaseChannel("stable", module, SDP_RAMP_PROVIDER_MATURITY)
      );
    }
  });

  it("keeps the shared skeleton within one block of every family", async () => {
    const skeleton = (
      renderToStaticMarkup(<IntegrationDetailSkeleton />).match(/rounded-2xl/g) ?? []
    ).length;

    for (const provider of ["privy", "moonpay", "range"]) {
      const detail = resolveIntegrationDetail({ provider, ...INPUTS });
      if (!detail) throw new Error(provider);
      const markup = await markupOf(<IntegrationDetailView detail={detail} />);
      const blocks =
        (markup.match(/<section/g) ?? []).length + (markup.match(/<header/g) ?? []).length;
      expect(Math.abs(blocks - skeleton)).toBeLessThanOrEqual(1);
    }
  });
});
