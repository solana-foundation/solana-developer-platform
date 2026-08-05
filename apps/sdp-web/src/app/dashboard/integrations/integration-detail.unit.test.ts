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

  it("resolves every non-custody family", () => {
    expect(resolveIntegrationDetail({ provider: "helius", ...INPUTS })?.family).toBe("rpc");
    expect(resolveIntegrationDetail({ provider: "moonpay", ...INPUTS })?.status).toBe("active");
    expect(resolveIntegrationDetail({ provider: "range", ...INPUTS })?.family).toBe("compliance");
  });

  it("keeps a known custody provider reachable when connection state is unknown", () => {
    const detail = resolveIntegrationDetail({ ...INPUTS, provider: "privy", custody: null });
    expect(detail).not.toBeNull();
    expect(detail?.statusUnknown).toBe(true);
    expect(detail?.custodyEntry?.id).toBe("privy");
  });

  it("rejects unknown providers before any data fetch", () => {
    expect(isKnownIntegrationProvider("not-a-provider")).toBe(false);
    expect(resolveIntegrationDetail({ provider: "nope", ...INPUTS })).toBeNull();
  });
});
