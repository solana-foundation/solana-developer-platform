import { describe, expect, it } from "vitest";
import { availableCustodyProviders } from "@/lib/provider-availability";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { getCustodyProviderEntry } from "./provider-catalog";
import { resolveCustodyProviderAvailability } from "./provider-display-status";

const CUSTODY_AVAILABILITY = availableCustodyProviders(
  projectProviderAvailability({
    project: SANDBOX_PROJECT,
    custody: [
      { provider: "fireblocks", modes: ["managed"] },
      { provider: "privy", modes: ["managed", "byok"] },
      { provider: "local", modes: ["managed"] },
    ],
    compliance: [],
    ramps: [],
    earn: [],
  })
);

describe("custody provider availability", () => {
  it("lists only the providers with modes, in catalog order, each with its modes", () => {
    expect(
      resolveCustodyProviderAvailability({
        connectedProviders: [],
        custodyAvailability: CUSTODY_AVAILABILITY,
      })
    ).toEqual([
      { entry: getCustodyProviderEntry("local"), status: "available", modes: ["managed"] },
      { entry: getCustodyProviderEntry("privy"), status: "available", modes: ["managed", "byok"] },
      { entry: getCustodyProviderEntry("fireblocks"), status: "available", modes: ["managed"] },
    ]);
  });

  it("gives no row to a provider whose modes are empty", () => {
    expect(
      resolveCustodyProviderAvailability({
        connectedProviders: [],
        custodyAvailability: [
          { family: "custody", provider: "turnkey", modes: [] },
          { family: "custody", provider: "privy", modes: ["byok"] },
        ],
      }).map((provider) => provider.entry.id)
    ).toEqual(["privy"]);
  });

  it("marks a connected provider active and the rest available", () => {
    expect(
      resolveCustodyProviderAvailability({
        connectedProviders: ["privy"],
        custodyAvailability: CUSTODY_AVAILABILITY,
      }).map((provider) => [provider.entry.id, provider.status])
    ).toEqual([
      ["local", "available"],
      ["privy", "active"],
      ["fireblocks", "available"],
    ]);
  });

  it("hides a connected provider the project can no longer use", () => {
    expect(
      resolveCustodyProviderAvailability({
        connectedProviders: ["turnkey"],
        custodyAvailability: CUSTODY_AVAILABILITY,
      }).map((provider) => provider.entry.id)
    ).toEqual(["local", "privy", "fireblocks"]);
  });

  it("lists nothing when the project can use no custody provider", () => {
    expect(
      resolveCustodyProviderAvailability({ connectedProviders: [], custodyAvailability: [] })
    ).toEqual([]);
  });
});
