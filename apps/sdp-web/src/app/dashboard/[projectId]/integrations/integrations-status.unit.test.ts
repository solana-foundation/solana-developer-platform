import { RAMP_PROVIDERS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  availableComplianceProviders,
  availableCustodyProviders,
  availableRampProviders,
} from "@/lib/provider-availability";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolvePrivacyIntegrations,
  resolveRampIntegrations,
} from "./integrations-status";

const AVAILABILITY = projectProviderAvailability({
  project: SANDBOX_PROJECT,
  custody: [
    { provider: "privy", modes: ["managed", "byok"] },
    { provider: "para", modes: ["managed"] },
  ],
  compliance: ["range"],
  ramps: ["moonpay", "stripe"],
  earn: [],
});

describe("integrations status", () => {
  it("lists only the ramp providers offered, so a provider the channel leaves out has no card", () => {
    const ramps = resolveRampIntegrations(availableRampProviders(AVAILABILITY), ["moonpay"]);

    expect(ramps.map((p) => p.provider)).toEqual(["moonpay"]);
  });

  it("lists only the custody providers the project can use, on the setup step's vocabulary", () => {
    const custody = resolveCustodyIntegrations({
      connectedProviders: ["privy", "turnkey"],
      custodyAvailability: availableCustodyProviders(AVAILABILITY),
    });

    expect(custody.map((p) => [p.entry.id, p.status])).toEqual([
      ["privy", "active"],
      ["para", "available"],
    ]);
  });

  it("lists only the available ramps, each enabled and never connected", () => {
    expect(resolveRampIntegrations(availableRampProviders(AVAILABILITY), RAMP_PROVIDERS)).toEqual([
      {
        provider: "moonpay",
        label: "MoonPay",
        status: "enabled",
        descriptionKey: "Shared.integrations.rampMoonpayDescription",
      },
      {
        provider: "stripe",
        label: "Stripe",
        status: "enabled",
        descriptionKey: "Shared.integrations.rampStripeDescription",
      },
    ]);
  });

  it("lists only the available compliance providers, each enabled", () => {
    expect(resolveComplianceIntegrations(availableComplianceProviders(AVAILABILITY))).toEqual([
      {
        provider: "range",
        label: "Range",
        status: "enabled",
        descriptionKey: "Shared.integrations.complianceRangeDescription",
      },
    ]);
  });

  it("lists nothing for a family the project can use no provider of", () => {
    const none = projectProviderAvailability({
      project: SANDBOX_PROJECT,
      custody: [],
      compliance: [],
      ramps: [],
      earn: [],
    });

    expect(
      resolveCustodyIntegrations({
        connectedProviders: ["privy"],
        custodyAvailability: availableCustodyProviders(none),
      })
    ).toEqual([]);
    expect(resolveRampIntegrations(availableRampProviders(none), RAMP_PROVIDERS)).toEqual([]);
    expect(resolveComplianceIntegrations(availableComplianceProviders(none))).toEqual([]);
  });

  it("maps the feature-gated Private Channels instance onto catalog states", () => {
    const label = "Private Channels";
    expect(resolvePrivacyIntegrations({ enabled: false, active: true, label })).toEqual([]);
    expect(resolvePrivacyIntegrations({ enabled: true, active: true, label })[0]?.status).toBe(
      "active"
    );
    expect(resolvePrivacyIntegrations({ enabled: true, active: false, label })[0]?.status).toBe(
      "available"
    );
    expect(resolvePrivacyIntegrations({ enabled: true, active: null, label })[0]?.status).toBe(
      "unknown"
    );
  });
});
