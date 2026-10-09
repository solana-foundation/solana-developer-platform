import {
  isModuleInReleaseChannel,
  isRampProviderInReleaseChannel,
  type RampProviderId,
  type SdpModule,
  type SdpRampProviderStages,
  type SdpReleaseChannel,
} from "@sdp/types";
import type { Adapter, Identify } from "flags";
import { flag } from "flags/next";
import { capAdapterToReleaseChannel } from "./release-channel";

export type DashboardFlagEntities = {
  user?: {
    email: string;
  };
};

/** Reads a flag's non-Vercel default from an optional env var override; the dashboard wins on Vercel deploys. Mirrors sdp-api's isTruthyFlag vocabulary so shared vars parse identically on both sides. */
function flagDefault(envVar: string, fallback: boolean): boolean {
  const value = process.env[envVar]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  throw new Error(`${envVar} must be a boolean value like "true" or "false", got "${value}"`);
}

export interface DashboardFlagDependencies {
  /** Reads the deployment's release channel, which caps every module and ramp provider flag. Called per decision. */
  releaseChannel: () => SdpReleaseChannel;
  /** Each ramp provider's stage (`SDP_RAMP_PROVIDER_STAGES` in the app). */
  rampProviderStages: SdpRampProviderStages;
  /** Creates the adapter that decides a flag inside the release channel (Vercel in the app). */
  vercel: () => Adapter<boolean, DashboardFlagEntities>;
  /** Resolves the entities targeting rules match against. */
  identify: Identify<DashboardFlagEntities>;
}

/**
 * Declares every dashboard flag. Module flags are capped at the release channel by their
 * module's stage, ramp provider flags by each provider's own stage; the rest are uncapped.
 * `index.ts` calls this once with the real dependencies; tests inject their own.
 */
export function defineDashboardFlags({
  releaseChannel,
  rampProviderStages,
  vercel,
  identify,
}: DashboardFlagDependencies) {
  function moduleAdapter(module: Exclude<SdpModule, "ramps">) {
    return capAdapterToReleaseChannel(
      () => isModuleInReleaseChannel(releaseChannel(), module, rampProviderStages),
      vercel()
    );
  }

  function rampProviderAdapter(provider: RampProviderId) {
    return capAdapterToReleaseChannel(
      () => isRampProviderInReleaseChannel(releaseChannel(), provider, rampProviderStages),
      vercel()
    );
  }

  /**
   * Creates a Vercel flag for one ramp provider.
   *
   * @param provider - The ramp provider identifier.
   * @param title - The provider's display title.
   * @returns The provider feature flag definition.
   */
  function rampProviderFlag(provider: RampProviderId, title: string) {
    return flag<boolean, DashboardFlagEntities>({
      key: `ramp-provider-${provider}`,
      adapter: rampProviderAdapter(provider),
      identify,
      defaultValue: flagDefault(`RAMP_PROVIDER_${provider.toUpperCase()}_ENABLED`, true),
      description: `Show ${title} as a selectable provider in the onramp and offramp wizards.`,
      options: [
        { value: false, label: "Hidden" },
        { value: true, label: "Enabled" },
      ],
    });
  }

  /**
   * Creates the flag for one design module: an area NEW DESIGN redesigns (lib/design-modules.ts).
   * The flag counts only while NEW DESIGN is on; on by default, so the area follows NEW DESIGN
   * until someone turns it off.
   *
   * @param key - The module's key suffix, e.g. `contacts` for `new-design-contacts`.
   * @param area - What the module covers, for the description.
   * @returns The module's feature flag definition.
   */
  function newDesignModuleFlag(key: string, area: string) {
    return flag<boolean, DashboardFlagEntities>({
      key: `new-design-${key}`,
      adapter: vercel(),
      identify,
      defaultValue: flagDefault(
        `SDP_FLAG_NEW_DESIGN_${key.toUpperCase().replaceAll("-", "_")}`,
        true
      ),
      description: `NEW DESIGN for ${area}. Requires the new-design flag; off serves that area's previous design.`,
      options: [
        { value: false, label: "Previous design" },
        { value: true, label: "New design" },
      ],
    });
  }

  const homepageOpenSignup = flag<boolean, DashboardFlagEntities>({
    key: "homepage-open-signup",
    adapter: vercel(),
    identify,
    defaultValue: flagDefault(
      "SDP_FLAG_HOMEPAGE_OPEN_SIGNUP",
      process.env.VERCEL_ENV !== "production"
    ),
    description: "Show self-serve signup and contact CTAs instead of the homepage waitlist CTA.",
    options: [
      { value: false, label: "Waitlist" },
      { value: true, label: "Open signup" },
    ],
  });

  const custody = flag<boolean, DashboardFlagEntities>({
    key: "custody",
    adapter: moduleAdapter("custody"),
    identify,
    defaultValue: flagDefault("CUSTODY_ENABLED", false),
    description:
      "Show the Custody module and Wallets workspace. Off hides every Custody and Wallets surface at once.",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const issuance = flag<boolean, DashboardFlagEntities>({
    key: "issuance",
    adapter: moduleAdapter("issuance"),
    identify,
    defaultValue: flagDefault("ISSUANCE_ENABLED", false),
    description:
      "Show the Issuance module. Off hides every Issuance surface at once, whatever the Asset Profiles flag says.",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const policies = flag<boolean, DashboardFlagEntities>({
    key: "policies",
    adapter: moduleAdapter("policies"),
    identify,
    defaultValue: flagDefault("POLICIES_ENABLED", false),
    description:
      "Show the Policies module, wallet-policy workspaces, and Approvals inbox. API key authoring remains available independently.",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const assetProfiles = flag<boolean, DashboardFlagEntities>({
    key: "asset-profiles",
    adapter: moduleAdapter("issuance"),
    identify,
    defaultValue: flagDefault("SDP_FLAG_ASSET_PROFILES", true),
    description:
      "Show the Asset Profiles issuance wizard and per-token asset management workspace. Requires the Issuance module flag.",
    options: [
      { value: false, label: "Legacy issuance" },
      { value: true, label: "Asset Profiles" },
    ],
  });

  const privateChannels = flag<boolean, DashboardFlagEntities>({
    key: "private-channels",
    adapter: moduleAdapter("private_channels"),
    identify,
    defaultValue: flagDefault("PRIVATE_CHANNELS_ENABLED", false),
    description:
      "Show the Private Channels payments workspace (instance, channels, members, deposits, transfers, withdrawals).",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const heliusRings = flag<boolean, DashboardFlagEntities>({
    key: "helius-rings",
    adapter: moduleAdapter("helius_rings"),
    identify,
    defaultValue: flagDefault("HELIUS_RINGS_ENABLED", false),
    description:
      "Show the Helius Rings devnet workspace (shielded wallets, private transfers, zones, timelocks).",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const payments = flag<boolean, DashboardFlagEntities>({
    key: "payments",
    adapter: moduleAdapter("payments"),
    identify,
    defaultValue: flagDefault("PAYMENTS_ENABLED", true),
    description:
      "Show the Payments module (transactions, counterparties, pay, deposit, requests, recurring). Off hides every Payments surface at once.",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const markets = flag<boolean, DashboardFlagEntities>({
    key: "markets",
    adapter: moduleAdapter("markets"),
    identify,
    defaultValue: flagDefault("MARKETS_ENABLED", false),
    description:
      "Show the Markets module — Earn today, further market workspaces later. Off hides every Markets surface at once, whatever the sub-module flags say.",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const dvp = flag<boolean, DashboardFlagEntities>({
    key: "dvp",
    adapter: moduleAdapter("dvp"),
    identify,
    defaultValue: flagDefault("DVP_ENABLED", false),
    description:
      "Show the DvP workspace (atomic delivery-versus-payment trades). A sub-module of Markets, so it also requires the markets flag. The swap program is deployed on devnet only, so the API answers 403 everywhere else regardless of this flag.",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const earn = flag<boolean, DashboardFlagEntities>({
    key: "earn",
    adapter: moduleAdapter("earn"),
    identify,
    defaultValue: flagDefault("EARN_ENABLED", false),
    description:
      "Show the Earn workspace (strategy catalogue, deposits, withdrawals). A sub-module of Markets, so it also requires the markets flag.",
    options: [
      { value: false, label: "Hidden" },
      { value: true, label: "Enabled" },
    ],
  });

  const newDesign = flag<boolean, DashboardFlagEntities>({
    key: "new-design",
    adapter: vercel(),
    identify,
    defaultValue: flagDefault("SDP_FLAG_NEW_DESIGN", process.env.VERCEL_ENV !== "production"),
    description:
      "NEW DESIGN: show the 2026 refresh's shell (palette, type and sidebar, the language switch in the account menu) and the Privacy connect form. Each redesigned area also has a new-design-* flag of its own, which counts only while this one is on. Off serves the previous design everywhere.",
    options: [
      { value: false, label: "Previous design" },
      { value: true, label: "New design" },
    ],
  });

  const newDesignContacts = newDesignModuleFlag(
    "contacts",
    "Payments' Contacts (the list, a new contact, one contact's page)"
  );

  const newDesignPayDeposit = newDesignModuleFlag("pay-deposit", "Payments' Pay and Deposit flows");
  const newDesignActivity = newDesignModuleFlag(
    "activity",
    "the rest of Payments (the overview and its API playground, Transactions, Requests, Schedules)"
  );

  const rampProviderMoonpay = rampProviderFlag("moonpay", "MoonPay");
  const rampProviderLightspark = rampProviderFlag("lightspark", "Lightspark");
  const rampProviderBvnk = rampProviderFlag("bvnk", "BVNK");
  const rampProviderMoneygram = rampProviderFlag("moneygram", "MoneyGram");
  const rampProviderCoinbase = rampProviderFlag("coinbase", "Coinbase");
  const rampProviderMural = rampProviderFlag("mural", "Mural Pay");
  const rampProviderStripe = rampProviderFlag("stripe", "Stripe");

  return {
    homepageOpenSignup,
    custody,
    issuance,
    policies,
    assetProfiles,
    privateChannels,
    heliusRings,
    payments,
    markets,
    dvp,
    earn,
    newDesign,
    newDesignContacts,
    newDesignPayDeposit,
    newDesignActivity,
    rampProviderMoonpay,
    rampProviderLightspark,
    rampProviderBvnk,
    rampProviderMoneygram,
    rampProviderCoinbase,
    rampProviderMural,
    rampProviderStripe,
  };
}
