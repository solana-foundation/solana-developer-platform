import { describe, expect, it } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import {
  availableComplianceProviders,
  availableCustodyProviders,
  availableRampProviders,
  isProviderAvailableForProject,
  offersCustodyMode,
} from "./provider-availability";

const AVAILABILITY = projectProviderAvailability({
  project: SANDBOX_PROJECT,
  custody: [
    { provider: "privy", modes: ["managed", "byok"] },
    { provider: "fireblocks", modes: ["managed"] },
  ],
  compliance: ["trm"],
  ramps: ["stripe", "moonpay"],
  earn: ["kamino"],
});

describe("availableCustodyProviders", () => {
  it("keeps only custody entries with modes, in tuple order", () => {
    expect(availableCustodyProviders(AVAILABILITY)).toEqual([
      { family: "custody", provider: "fireblocks", modes: ["managed"] },
      { family: "custody", provider: "privy", modes: ["managed", "byok"] },
    ]);
  });

  it("returns nothing when no custody provider has a mode", () => {
    const availability = projectProviderAvailability({
      project: SANDBOX_PROJECT,
      custody: [],
      compliance: ["trm"],
      ramps: ["stripe"],
      earn: [],
    });

    expect(availableCustodyProviders(availability)).toEqual([]);
  });
});

describe("availableRampProviders", () => {
  it("lists the available ramp providers in tuple order", () => {
    expect(availableRampProviders(AVAILABILITY)).toEqual(["moonpay", "stripe"]);
  });
});

describe("availableComplianceProviders", () => {
  it("lists the available compliance providers in tuple order", () => {
    expect(availableComplianceProviders(AVAILABILITY)).toEqual(["trm"]);
  });
});

describe("isProviderAvailableForProject", () => {
  it("accepts a custody provider with at least one mode", () => {
    expect(isProviderAvailableForProject(AVAILABILITY, "fireblocks")).toBe(true);
  });

  it("rejects a custody provider with no modes", () => {
    expect(isProviderAvailableForProject(AVAILABILITY, "turnkey")).toBe(false);
  });

  it("accepts an available provider of every other family", () => {
    expect(isProviderAvailableForProject(AVAILABILITY, "trm")).toBe(true);
    expect(isProviderAvailableForProject(AVAILABILITY, "stripe")).toBe(true);
    expect(isProviderAvailableForProject(AVAILABILITY, "kamino")).toBe(true);
  });

  it("rejects an unavailable provider of every other family", () => {
    expect(isProviderAvailableForProject(AVAILABILITY, "chainalysis")).toBe(false);
    expect(isProviderAvailableForProject(AVAILABILITY, "bvnk")).toBe(false);
    expect(isProviderAvailableForProject(AVAILABILITY, "veda")).toBe(false);
  });

  it("rejects a provider the deployment does not know", () => {
    expect(isProviderAvailableForProject(AVAILABILITY, "unknown-provider")).toBe(false);
  });
});

describe("offersCustodyMode", () => {
  it("accepts each mode a custody provider lists", () => {
    expect(offersCustodyMode(AVAILABILITY, "privy", "managed")).toBe(true);
    expect(offersCustodyMode(AVAILABILITY, "privy", "byok")).toBe(true);
  });

  it("rejects a mode the custody provider leaves out", () => {
    expect(offersCustodyMode(AVAILABILITY, "fireblocks", "byok")).toBe(false);
  });

  it("rejects every mode for a custody provider with none", () => {
    expect(offersCustodyMode(AVAILABILITY, "turnkey", "managed")).toBe(false);
    expect(offersCustodyMode(AVAILABILITY, "turnkey", "byok")).toBe(false);
  });
});
