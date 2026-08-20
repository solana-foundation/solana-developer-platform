import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolveIntegrationDetail } from "../integration-detail";
import { IntegrationDetailSkeleton } from "../integrations-skeleton";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
  resolveRpcIntegrations,
} from "../integrations-status";
import type { RpcConnectionContext } from "./integration-detail-view";
import { IntegrationDetailView } from "./integration-detail-view";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "en" }) }),
  headers: async () => new Headers(),
}));
// The panel is a client component with its own test; here we only care that
// the view mounts it for the RPC family and drops the Settings signpost.
vi.mock("../rpc-connection-panel", () => ({
  RpcConnectionPanel: ({ provider }: { provider: string }) => (
    <div data-rpc-panel={provider}>rpc-connection-panel</div>
  ),
}));
vi.mock("../rpc-byok-section", () => ({
  RpcByokSection: ({ provider }: { provider: string }) => <div data-rpc-byok={provider} />,
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
    // No request route exists for IBM Haven yet (HOO-775): the page must not
    // claim access is requestable, must not carry another provider's form,
    // and must still say how access is actually arranged.
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

  it("manages an RPC provider on its own page instead of sending it to Settings", async () => {
    const detail = resolveIntegrationDetail({ ...INPUTS, provider: "helius" });
    if (!detail) throw new Error("expected detail");
    const markup = renderToStaticMarkup(
      await IntegrationDetailView({
        detail,
        rpc: {
          activeProvider: "helius",
          canManage: true,
          isEnabledInDeployment: true,
          organizationId: "org_1",
        },
      })
    );
    expect(markup).toContain("Connection");
    expect(markup).toContain('data-rpc-panel="helius"');
    expect(markup).not.toContain("Change in Settings");
  });

  it("offers no RPC action when the organization could not be resolved", async () => {
    const markup = await render("helius");
    // No rpc context means no panel. Settings no longer holds RPC, so linking
    // there would be a dead end rather than a fallback.
    expect(markup).not.toContain("/dashboard/settings");
    expect(markup).not.toContain("rpc-connection-panel");
  });

  it("offers no state-dependent action when the connection state is unknown", async () => {
    const detail = resolveIntegrationDetail({ ...INPUTS, provider: "privy", custody: null });
    if (!detail) throw new Error("expected detail");
    const markup = renderToStaticMarkup(await IntegrationDetailView({ detail }));
    expect(markup).toContain("Status unavailable");
    expect(markup).not.toContain("/dashboard/wallets/setup");
    expect(markup).not.toContain(">Manage<");
  });

  it("keeps the shared skeleton within one block of every family", async () => {
    // The skeleton cannot match all four families, so the rule is that it sits
    // within one block of each. A new section pushes some family to two.
    const skeleton = (
      renderToStaticMarkup(<IntegrationDetailSkeleton />).match(/rounded-2xl/g) ?? []
    ).length;

    const cases: Array<[string, RpcConnectionContext | undefined]> = [
      [
        "helius",
        {
          activeProvider: "helius",
          canManage: true,
          isEnabledInDeployment: true,
          organizationId: "o",
          byokConnections: [],
        },
      ],
      ["privy", undefined],
      ["moonpay", undefined],
      ["range", undefined],
    ];

    for (const [provider, rpc] of cases) {
      const detail = resolveIntegrationDetail({ provider, ...INPUTS });
      if (!detail) throw new Error(provider);
      const markup = renderToStaticMarkup(await IntegrationDetailView({ detail, rpc }));
      const blocks =
        (markup.match(/<section/g) ?? []).length + (markup.match(/<header/g) ?? []).length;
      expect(Math.abs(blocks - skeleton)).toBeLessThanOrEqual(1);
    }
  });
});
