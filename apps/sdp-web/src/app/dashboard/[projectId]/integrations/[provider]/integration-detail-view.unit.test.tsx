import { RAMP_PROVIDERS } from "@sdp/types";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableComplianceProviders,
  availableCustodyProviders,
  availableRampProviders,
} from "@/lib/provider-availability";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { resetRequestProject, setPageRequest } from "@/test/request-project";
import { resolveIntegrationDetail } from "../integration-detail";
import { IntegrationDetailSkeleton } from "../integrations-skeleton";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
} from "../integrations-status";
import { IntegrationDetailView } from "./integration-detail-view";

vi.mock("next/headers", () => import("@/test/next-headers"));

const PROJECT_PATH = `/dashboard/${SANDBOX_PROJECT.id}`;

const AVAILABILITY = projectProviderAvailability({
  project: SANDBOX_PROJECT,
  custody: [
    { provider: "privy", modes: ["managed", "byok"] },
    { provider: "para", modes: ["managed"] },
    { provider: "fireblocks", modes: ["managed"] },
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

async function render(provider: string): Promise<string> {
  const detail = resolveIntegrationDetail({ provider, ...INPUTS });
  if (!detail) throw new Error(`unknown provider ${provider}`);
  return markupOf(<IntegrationDetailView detail={detail} />);
}

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
    const markup = await render("fireblocks");
    expect(markup).toContain("Ready to connect");
    expect(markup).toContain(`${PROJECT_PATH}/wallets/setup?provider=fireblocks`);
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
