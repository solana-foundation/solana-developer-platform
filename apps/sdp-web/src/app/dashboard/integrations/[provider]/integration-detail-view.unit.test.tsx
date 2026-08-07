import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolveIntegrationDetail } from "../integration-detail";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
  resolveRpcIntegrations,
} from "../integrations-status";
import { IntegrationDetailView } from "./integration-detail-view";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "en" }) }),
  headers: async () => new Headers(),
}));

const on = { entitled: true, configured: true, enabled: true };
const off = { entitled: false, configured: false, enabled: false };

const INPUTS = {
  custody: resolveCustodyIntegrations({
    connectedProviders: ["privy"],
    enabledProviders: ["privy", "para"],
  }),
  rpc: resolveRpcIntegrations({
    selectedProvider: "helius",
    entries: { helius: on, alchemy: on },
  }),
  ramps: resolveRampIntegrations({ moonpay: on }),
  compliance: resolveComplianceIntegrations({ range: off }),
};

async function render(provider: string): Promise<string> {
  const detail = resolveIntegrationDetail({ provider, ...INPUTS });
  if (!detail) throw new Error(`unknown provider ${provider}`);
  return renderToStaticMarkup(await IntegrationDetailView({ detail }));
}

describe("IntegrationDetailView", () => {
  it("gives a connected custody provider a manage action", async () => {
    const markup = await render("privy");
    expect(markup).toContain("Connected");
    expect(markup).toContain("/dashboard/wallets");
    expect(markup).toContain("Manage");
  });

  it("routes an available custody provider into setup", async () => {
    const markup = await render("para");
    expect(markup).toContain("Ready to connect");
    expect(markup).toContain("/dashboard/wallets/setup?provider=para");
  });

  it("gives the one routed gated provider its request access button", async () => {
    const markup = await render("fireblocks");
    expect(markup).toContain("Request access");
    expect(markup).toContain("https://solanafoundation.typeform.com/to/wShiq9SN");
    expect(markup).toContain("Available by arrangement");
  });

  it("explains an unrouted gated provider without borrowing a link", async () => {
    const markup = await render("ibm_haven");
    expect(markup).toContain("Request access");
    // No request route exists for IBM Haven yet (HOO-775): the page must say
    // how access is arranged and must not carry another provider's form.
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
    const markup = renderToStaticMarkup(await IntegrationDetailView({ detail }));
    expect(markup).toContain("Status unavailable");
    expect(markup).not.toContain("/dashboard/wallets/setup");
    expect(markup).not.toContain(">Manage<");
  });
});
