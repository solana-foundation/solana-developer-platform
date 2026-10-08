import {
  isModuleInReleaseChannel,
  isRampProviderInReleaseChannel,
  RAMP_PROVIDERS,
  type RampProviderId,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types";
import type { Adapter } from "flags";
import { describe, expect, it } from "vitest";
import { type DashboardFlagEntities, defineDashboardFlags } from "./definitions";

type DashboardFlags = ReturnType<typeof defineDashboardFlags>;

/** What caps each flag: a module's stage, a ramp provider's own stage, or nothing. */
type FlagCap =
  | { module: Exclude<SdpModule, "ramps"> }
  | { rampProvider: RampProviderId }
  | "uncapped";

const FLAG_CAPS = {
  homepageOpenSignup: "uncapped",
  newDesign: "uncapped",
  newDesignContacts: "uncapped",
  custody: { module: "custody" },
  privyByok: { module: "custody" },
  issuance: { module: "issuance" },
  assetProfiles: { module: "issuance" },
  policies: { module: "policies" },
  privateChannels: { module: "private_channels" },
  heliusRings: { module: "helius_rings" },
  payments: { module: "payments" },
  markets: { module: "markets" },
  dvp: { module: "dvp" },
  earn: { module: "earn" },
  rampProviderMoonpay: { rampProvider: "moonpay" },
  rampProviderLightspark: { rampProvider: "lightspark" },
  rampProviderBvnk: { rampProvider: "bvnk" },
  rampProviderMoneygram: { rampProvider: "moneygram" },
  rampProviderCoinbase: { rampProvider: "coinbase" },
  rampProviderMural: { rampProvider: "mural" },
  rampProviderStripe: { rampProvider: "stripe" },
} as const satisfies Record<keyof DashboardFlags, FlagCap>;

/** Stands in for Vercel: serves every flag on, so a capped flag is the only way to read false. */
const vercelServesOn: Adapter<boolean, DashboardFlagEntities> = {
  origin: "https://vercel.com/flags",
  decide: () => true,
};

function defineFlags(
  releaseChannel: SdpReleaseChannel,
  rampProviderStages: Record<RampProviderId, SdpReleaseChannel> = SDP_RAMP_PROVIDER_STAGES
) {
  return defineDashboardFlags({
    releaseChannel: () => releaseChannel,
    rampProviderStages,
    vercel: () => vercelServesOn,
    identify: () => ({}),
  });
}

async function decideAll(flags: DashboardFlags): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    Object.entries(flags).map(async ([name, flag]) => {
      if (!flag.decide) throw new Error(`${name} declares no decide function`);
      // SAFETY: no adapter under test reads headers or cookies; a real store needs a request.
      const value = await flag.decide({ headers: new Headers(), cookies: new Map() as never });
      return [name, value] as const;
    })
  );
  return Object.fromEntries(entries);
}

function inReleaseChannel(releaseChannel: SdpReleaseChannel, cap: FlagCap): boolean {
  if (cap === "uncapped") return true;
  if ("module" in cap) {
    return isModuleInReleaseChannel(releaseChannel, cap.module, SDP_RAMP_PROVIDER_STAGES);
  }
  return isRampProviderInReleaseChannel(releaseChannel, cap.rampProvider, SDP_RAMP_PROVIDER_STAGES);
}

const EXCLUDED_FROM_STABLE = Object.entries(FLAG_CAPS)
  .filter(([, cap]) => !inReleaseChannel("stable", cap))
  .map(([name]) => name);

const RAMP_PROVIDER_FLAG_NAMES = {
  moonpay: "rampProviderMoonpay",
  lightspark: "rampProviderLightspark",
  bvnk: "rampProviderBvnk",
  moneygram: "rampProviderMoneygram",
  coinbase: "rampProviderCoinbase",
  mural: "rampProviderMural",
  stripe: "rampProviderStripe",
} as const satisfies Record<RampProviderId, keyof DashboardFlags>;

describe("defineDashboardFlags", () => {
  it("classifies every flag it declares", () => {
    expect(Object.keys(defineFlags("experimental")).sort()).toEqual(Object.keys(FLAG_CAPS).sort());
  });

  it("delegates every flag to its Vercel decision on experimental", async () => {
    const values = await decideAll(defineFlags("experimental"));
    expect(Object.entries(values).filter(([, value]) => !value)).toEqual([]);
  });

  it.each(EXCLUDED_FROM_STABLE)("serves %s off on stable whatever Vercel says", async (name) => {
    const values = await decideAll(defineFlags("stable"));
    expect(values[name]).toBe(false);
  });

  it("keeps stable modules and uncapped flags on Vercel's decision on stable", async () => {
    const values = await decideAll(defineFlags("stable"));
    const delegated = Object.keys(FLAG_CAPS).filter((name) => !EXCLUDED_FROM_STABLE.includes(name));
    expect(delegated.sort()).toEqual(
      [
        "custody",
        "homepageOpenSignup",
        "newDesign",
        "newDesignContacts",
        "payments",
        "privyByok",
      ].sort()
    );
    for (const name of delegated) {
      expect(values[name], name).toBe(true);
    }
  });

  it("caps each ramp provider flag by that provider's own stage, not by Ramps as a whole", async () => {
    const onlyMoonpayStable = {
      ...SDP_RAMP_PROVIDER_STAGES,
      moonpay: "stable",
    } as const satisfies Record<RampProviderId, SdpReleaseChannel>;
    const values = await decideAll(defineFlags("stable", onlyMoonpayStable));

    for (const provider of RAMP_PROVIDERS) {
      expect(values[RAMP_PROVIDER_FLAG_NAMES[provider]], provider).toBe(provider === "moonpay");
    }
  });
});
