import { describe, expect, it } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import {
  availableCustodyProviders,
  offersCustodyMode,
  providerAccessRefusal,
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
      {
        family: "custody",
        provider: "fireblocks",
        modes: ["managed"],
        unavailableModes: [{ mode: "byok", reason: "provider_not_entitled" }],
      },
      {
        family: "custody",
        provider: "privy",
        modes: ["managed", "byok"],
        unavailableModes: [],
      },
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

describe("providerAccessRefusal", () => {
  it.each([
    [{ entitled: false, configured: false, enabled: false }, "not_entitled"],
    [{ entitled: false, configured: true, enabled: true }, "not_entitled"],
    [{ entitled: true, configured: false, enabled: true }, "not_configured"],
    [{ entitled: true, configured: true, enabled: false }, "disabled"],
    [{ entitled: true, configured: true, enabled: true }, null],
  ] as const)("answers %o with %s, in the order the API checks", (entry, refusal) => {
    expect(providerAccessRefusal(entry)).toBe(refusal);
  });
});
