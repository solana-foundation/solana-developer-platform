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

export const organizationOnboarding = flag<boolean, DashboardFlagEntities>({
  key: "organization-onboarding",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("SDP_FLAG_ORGANIZATION_ONBOARDING", true),
  description:
    "Require newly created organizations to choose RPC and custody providers before entering the dashboard.",
  options: [
    { value: false, label: "Skip onboarding" },
    { value: true, label: "Require onboarding" },
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
  description: "Show the Asset Profiles issuance wizard and per-token asset management workspace.",
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

export const rampProviderMoonpay = rampProviderFlag("moonpay", "MoonPay");
export const rampProviderLightspark = rampProviderFlag("lightspark", "Lightspark");
export const rampProviderBvnk = rampProviderFlag("bvnk", "BVNK");
export const rampProviderMoneygram = rampProviderFlag("moneygram", "MoneyGram");
export const rampProviderCoinbase = rampProviderFlag("coinbase", "Coinbase");
export const rampProviderMural = rampProviderFlag("mural", "Mural Pay");
export const rampProviderStripe = rampProviderFlag("stripe", "Stripe");
