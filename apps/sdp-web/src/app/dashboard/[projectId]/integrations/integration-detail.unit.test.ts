import {
  COMPLIANCE_PROVIDERS,
  CUSTODY_PROVIDERS,
  type ProjectProviderAvailability,
  RAMP_PROVIDERS,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  availableComplianceProviders,
  availableCustodyProviders,
  availableRampProviders,
} from "@/lib/provider-availability";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { isKnownIntegrationProvider, resolveIntegrationDetail } from "./integration-detail";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
} from "./integrations-status";

function detailInputs(availability: ProjectProviderAvailability) {
  return {
    custody: resolveCustodyIntegrations({
      connectedProviders: ["privy"],
      custodyAvailability: availableCustodyProviders(availability),
    }),
    ramps: resolveRampIntegrations(availableRampProviders(availability), RAMP_PROVIDERS),
    compliance: resolveComplianceIntegrations(availableComplianceProviders(availability)),
  };
}

const INPUTS = detailInputs(
  projectProviderAvailability({
    project: SANDBOX_PROJECT,
    custody: [
      { provider: "privy", modes: ["managed", "byok"] },
      { provider: "para", modes: ["managed"] },
    ],
    compliance: ["range"],
    ramps: ["moonpay"],
    earn: [],
  })
);

const EVERY_PROVIDER_INPUTS = detailInputs(
  projectProviderAvailability({
    project: SANDBOX_PROJECT,
    custody: CUSTODY_PROVIDERS.map((provider) => ({ provider, modes: ["managed"] })),
    compliance: COMPLIANCE_PROVIDERS,
    ramps: RAMP_PROVIDERS,
    earn: [],
  })
);

describe("integration detail", () => {
  it("resolves a custody provider with its catalog entry and status", () => {
    const detail = resolveIntegrationDetail({ provider: "privy", ...INPUTS });
    expect(detail?.family).toBe("custody");
    expect(detail?.status).toBe("active");
    expect(detail?.custodyEntry?.useCases.length).toBeGreaterThan(0);
  });

  it("resolves no detail for a provider the project cannot use", () => {
    for (const provider of ["fireblocks", "bvnk", "trm"]) {
      expect(resolveIntegrationDetail({ provider, ...INPUTS })).toBeNull();
    }
  });

  it("resolves every non-custody family", () => {
    expect(resolveIntegrationDetail({ provider: "moonpay", ...INPUTS })?.status).toBe("enabled");
    expect(resolveIntegrationDetail({ provider: "range", ...INPUTS })?.family).toBe("compliance");
  });

  it("recognises every provider the catalog can render, without a hand-written list", () => {
    // Guards the drift Opeyemi flagged: a newly added ramp used to get a card
    // that 404'd on click, because the id lists here were literals.
    for (const family of [EVERY_PROVIDER_INPUTS.ramps, EVERY_PROVIDER_INPUTS.compliance]) {
      for (const row of family) {
        expect(isKnownIntegrationProvider(row.provider)).toBe(true);
      }
    }
    expect(EVERY_PROVIDER_INPUTS.custody).toHaveLength(CUSTODY_PROVIDERS.length);
    for (const row of EVERY_PROVIDER_INPUTS.custody) {
      expect(isKnownIntegrationProvider(row.entry.id)).toBe(true);
    }
  });

  it("rejects unknown providers before any data fetch", () => {
    expect(isKnownIntegrationProvider("not-a-provider")).toBe(false);
    expect(resolveIntegrationDetail({ provider: "nope", ...INPUTS })).toBeNull();
  });
});
