import { describe, expect, it } from "vitest";
import { isKnownIntegrationProvider, resolveIntegrationDetail } from "./integration-detail";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
  resolveRpcIntegrations,
} from "./integrations-status";

const on = { entitled: true, configured: true, enabled: true };

const INPUTS = {
  custody: resolveCustodyIntegrations({
    connectedProviders: ["privy"],
    enabledProviders: ["privy", "para"],
  }),
  rpc: resolveRpcIntegrations({ selectedProvider: "helius", entries: { helius: on } }),
  ramps: resolveRampIntegrations({ moonpay: on }),
  compliance: resolveComplianceIntegrations({}),
};

describe("integration detail", () => {
  it("resolves a custody provider with its catalog entry and status", () => {
    const detail = resolveIntegrationDetail({ provider: "privy", ...INPUTS });
    expect(detail?.family).toBe("custody");
    expect(detail?.status).toBe("active");
    expect(detail?.custodyEntry?.useCases.length).toBeGreaterThan(0);
  });

  it("carries the request access route for a gated provider", () => {
    const detail = resolveIntegrationDetail({ provider: "fireblocks", ...INPUTS });
    expect(detail?.status).toBe("request_access");
    expect(detail?.requestAccessUrl).toContain("typeform");
  });

  it("gives a gated provider without an established route no URL at all", () => {
    // IBM Haven's request route is HOO-775; until it exists the page explains
    // the arrangement instead of borrowing another provider's form.
    const detail = resolveIntegrationDetail({ provider: "ibm_haven", ...INPUTS });
    expect(detail?.status).toBe("request_access");
    expect(detail?.requestAccessUrl).toBeUndefined();
  });

  it("resolves every non-custody family", () => {
    expect(resolveIntegrationDetail({ provider: "helius", ...INPUTS })?.family).toBe("rpc");
    expect(resolveIntegrationDetail({ provider: "moonpay", ...INPUTS })?.status).toBe("enabled");
    expect(resolveIntegrationDetail({ provider: "range", ...INPUTS })?.family).toBe("compliance");
  });

  it("keeps a known custody provider reachable when connection state is unknown", () => {
    const detail = resolveIntegrationDetail({ ...INPUTS, provider: "privy", custody: null });
    expect(detail).not.toBeNull();
    expect(detail?.status).toBe("unknown");
    expect(detail?.custodyEntry?.id).toBe("privy");
  });

  it("recognises every provider the catalog can render, without a hand-written list", () => {
    // Guards the drift Opeyemi flagged: a newly added ramp used to get a card
    // that 404'd on click, because the id lists here were literals.
    for (const family of [INPUTS.rpc, INPUTS.ramps, INPUTS.compliance]) {
      for (const row of family) {
        expect(isKnownIntegrationProvider(row.provider)).toBe(true);
      }
    }
    for (const row of INPUTS.custody) {
      expect(isKnownIntegrationProvider(row.entry.id)).toBe(true);
    }
  });

  it("rejects unknown providers before any data fetch", () => {
    expect(isKnownIntegrationProvider("not-a-provider")).toBe(false);
    expect(resolveIntegrationDetail({ provider: "nope", ...INPUTS })).toBeNull();
  });
});
