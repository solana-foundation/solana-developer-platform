import { vercelAdapter } from "@flags-sdk/vercel";
import type { RampProviderId } from "@sdp/types";
import { dedupe, flag } from "flags/next";
import { getSdpAuth } from "@/lib/sdp-api";

type DashboardFlagEntities = {
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

/**
 * Resolves the entities Vercel Flags targeting rules match against: the
 * signed-in user's email. Signed-out sessions — and Clerk instances whose
 * session token lacks the `email` custom claim (Clerk Dashboard → Sessions →
 * Customize session token) — resolve to no entities, so email-targeted rules
 * skip and each flag serves its environment fallthrough or `defaultValue`.
 *
 * @returns The targeting entities for the current request.
 */
const identifyDashboardEntities = dedupe(async (): Promise<DashboardFlagEntities> => {
  const { userId, sessionClaims } = await getSdpAuth();

  if (!userId) {
    return {};
  }

  const email = sessionClaims.email;
  if (typeof email !== "string" || email.length === 0) {
    console.warn(
      "Clerk session token has no `email` claim; email-targeted flag rules will not match. Add it under Clerk Dashboard → Sessions → Customize session token."
    );
    return {};
  }

  return {
    user: { email },
  };
});

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
    adapter: vercelAdapter(),
    identify: identifyDashboardEntities,
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
    adapter: vercelAdapter(),
    identify: identifyDashboardEntities,
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

export const homepageOpenSignup = flag<boolean, DashboardFlagEntities>({
  key: "homepage-open-signup",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
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

export const custody = flag<boolean, DashboardFlagEntities>({
  key: "custody",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("CUSTODY_ENABLED", false),
  description:
    "Show the Custody module and Wallets workspace. Off hides every Custody and Wallets surface at once.",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const issuance = flag<boolean, DashboardFlagEntities>({
  key: "issuance",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("ISSUANCE_ENABLED", false),
  description:
    "Show the Issuance module. Off hides every Issuance surface at once, whatever the Asset Profiles flag says.",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const policies = flag<boolean, DashboardFlagEntities>({
  key: "policies",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("POLICIES_ENABLED", false),
  description:
    "Show the Policies module, wallet-policy workspaces, and Approvals inbox. API key authoring remains available independently.",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const privyByok = flag<boolean, DashboardFlagEntities>({
  key: "privy-byok",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("SDP_FLAG_PRIVY_BYOK", false),
  description:
    "Install Privy from stored project credentials instead of the legacy env-backed initialize path. Requires PRIVY_BYOK_ENABLED on the API.",
  options: [
    { value: false, label: "Legacy initialize" },
    { value: true, label: "Stored credentials" },
  ],
});

export const assetProfiles = flag<boolean, DashboardFlagEntities>({
  key: "asset-profiles",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("SDP_FLAG_ASSET_PROFILES", true),
  description:
    "Show the Asset Profiles issuance wizard and per-token asset management workspace. Requires the Issuance module flag.",
  options: [
    { value: false, label: "Legacy issuance" },
    { value: true, label: "Asset Profiles" },
  ],
});

export const privateChannels = flag<boolean, DashboardFlagEntities>({
  key: "private-channels",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("PRIVATE_CHANNELS_ENABLED", false),
  description:
    "Show the Private Channels payments workspace (instance, channels, members, deposits, transfers, withdrawals).",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const heliusRings = flag<boolean, DashboardFlagEntities>({
  key: "helius-rings",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("HELIUS_RINGS_ENABLED", false),
  description:
    "Show the Helius Rings devnet workspace (shielded wallets, private transfers, zones, timelocks).",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const payments = flag<boolean, DashboardFlagEntities>({
  key: "payments",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("PAYMENTS_ENABLED", true),
  description:
    "Show the Payments module (transactions, counterparties, pay, deposit, requests, recurring). Off hides every Payments surface at once.",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const markets = flag<boolean, DashboardFlagEntities>({
  key: "markets",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("MARKETS_ENABLED", false),
  description:
    "Show the Markets module — Earn today, further market workspaces later. Off hides every Markets surface at once, whatever the sub-module flags say.",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const dvp = flag<boolean, DashboardFlagEntities>({
  key: "dvp",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("DVP_ENABLED", false),
  description:
    "Show the DvP workspace (atomic delivery-versus-payment trades). A sub-module of Markets, so it also requires the markets flag. The swap program is deployed on devnet only, so the API answers 403 everywhere else regardless of this flag.",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const earn = flag<boolean, DashboardFlagEntities>({
  key: "earn",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("EARN_ENABLED", false),
  description:
    "Show the Earn workspace (strategy catalogue, deposits, withdrawals). A sub-module of Markets, so it also requires the markets flag.",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const newDesign = flag<boolean, DashboardFlagEntities>({
  key: "new-design",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("SDP_FLAG_NEW_DESIGN", process.env.VERCEL_ENV !== "production"),
  description:
    "NEW DESIGN: show the 2026 refresh's shell (palette, type and sidebar, the language switch in the account menu) and the Privacy connect form. Each redesigned area also has a new-design-* flag of its own, which counts only while this one is on. Off serves the previous design everywhere.",
  options: [
    { value: false, label: "Previous design" },
    { value: true, label: "New design" },
  ],
});

export const paymentsDemoMode = flag<boolean, DashboardFlagEntities>({
  key: "payments-demo-mode",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("SDP_FLAG_PAYMENTS_DEMO_MODE", process.env.VERCEL_ENV !== "production"),
  description:
    "Offer Payments' Demo switch: sample data and simulated provider, KYC and settlement steps in every ramp flow, per project. Requires the new-design flag, and serves only Payments pages on the new design.",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Enabled" },
  ],
});

export const newDesignOverview = newDesignModuleFlag(
  "overview",
  "the dashboard's Overview (the page, its name in the sidebar, the new quick start)"
);

export const newDesignWallets = newDesignModuleFlag(
  "wallets",
  "Wallets (the list, the create flow, one wallet's page, pinned wallets in the sidebar)"
);

export const newDesignContacts = newDesignModuleFlag(
  "contacts",
  "Payments' Contacts (the list, a new contact, one contact's page)"
);

export const newDesignPayDeposit = newDesignModuleFlag(
  "pay-deposit",
  "Payments' Pay and Deposit flows"
);

export const newDesignActivity = newDesignModuleFlag(
  "activity",
  "the rest of Payments (the overview and its API playground, Transactions, Requests, Schedules)"
);

export const rampProviderMoonpay = rampProviderFlag("moonpay", "MoonPay");
export const rampProviderLightspark = rampProviderFlag("lightspark", "Lightspark");
export const rampProviderBvnk = rampProviderFlag("bvnk", "BVNK");
export const rampProviderMoneygram = rampProviderFlag("moneygram", "MoneyGram");
export const rampProviderCoinbase = rampProviderFlag("coinbase", "Coinbase");
export const rampProviderMural = rampProviderFlag("mural", "Mural Pay");
export const rampProviderStripe = rampProviderFlag("stripe", "Stripe");
