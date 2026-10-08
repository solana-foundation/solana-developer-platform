import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
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

const PROJECT_PATH = `/dashboard/${PRODUCTION_PROJECT.id}`;

const on = { entitled: true, configured: true, enabled: true };
const off = { entitled: false, configured: false, enabled: false };

const INPUTS = {
  custody: resolveCustodyIntegrations({
    connectedProviders: ["privy"],
    enabledProviders: ["privy", "para"],
  }),
  ramps: resolveRampIntegrations({ moonpay: on }),
  compliance: resolveComplianceIntegrations({ range: off }),
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

  it("gives the one routed gated provider its request access button", async () => {
    const markup = await render("fireblocks");
    expect(markup).toContain("Request access");
    expect(markup).toContain("https://solanafoundation.typeform.com/to/wShiq9SN");
    expect(markup).toContain("Available by arrangement");
  });

  it("explains an unrouted gated provider without borrowing a link", async () => {
    const markup = await render("ibm_haven");
    expect(markup).toContain("Not configured");
    expect(markup).not.toContain("Request access");
    expect(markup).not.toContain("typeform.com");
    expect(markup).toContain("Available by arrangement");
  });

  it("always says how a non-custody provider connects", async () => {
    const ramp = await render("moonpay");
    expect(ramp).toContain("Enabled");
    expect(ramp).toContain("Provisioned per deployment");

    const compliance = await render("range");
    expect(compliance).toContain("Request access");
    expect(compliance).toContain("Available by arrangement");
    expect(compliance).not.toContain("typeform.com");
  });

  it("offers no state-dependent action when the connection state is unknown", async () => {
    const detail = resolveIntegrationDetail({ ...INPUTS, provider: "privy", custody: null });
    if (!detail) throw new Error("expected detail");
    const markup = await markupOf(<IntegrationDetailView detail={detail} />);
    expect(markup).toContain("Status unavailable");
    expect(markup).not.toContain(`${PROJECT_PATH}/wallets/setup`);
    expect(markup).not.toContain(">Manage<");
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
