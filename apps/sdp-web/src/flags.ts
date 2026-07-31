import { createVercelAdapter, vercelAdapter } from "@flags-sdk/vercel";
import { createClient } from "@vercel/flags-core";
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
 * Adapter serving the dashboard flags. On Vercel deploys this is the default
 * streaming adapter (build-time bundled definitions cover its fallback). In
 * local dev the stream regularly misses the SDK's 3s init timeout, which made
 * every flag silently serve its defaultValue until the background connection
 * caught up — so dev polls the datafile instead: the initial fetch resolves in
 * well under the init timeout, and dashboard changes still land within the
 * polling interval.
 */
const dashboardFlagsAdapter =
  process.env.NODE_ENV === "development"
    ? createVercelAdapter(
        createClient(process.env.FLAGS, {
          stream: false,
          polling: { intervalMs: 30_000, initTimeoutMs: 10_000 },
        })
      )
    : vercelAdapter;

export const homepageOpenSignup = flag<boolean, DashboardFlagEntities>({
  key: "homepage-open-signup",
  adapter: dashboardFlagsAdapter(),
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
  adapter: dashboardFlagsAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("SDP_FLAG_ORGANIZATION_ONBOARDING", true),
  description:
    "Require newly created organizations to choose RPC and custody providers before entering the dashboard.",
  options: [
    { value: false, label: "Skip onboarding" },
    { value: true, label: "Require onboarding" },
  ],
});

export const alphaledgerTokenizationEngine = flag<boolean, DashboardFlagEntities>({
  key: "alphaledger-tokenization-engine",
  adapter: dashboardFlagsAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("SDP_FLAG_ALPHALEDGER_TOKENIZATION_ENGINE", false),
  description: "Offer the AlphaLedger tokenization engine as an issuance provider option.",
  options: [
    { value: false, label: "Mosaic only" },
    { value: true, label: "AlphaLedger available" },
  ],
});

export const assetProfiles = flag<boolean, DashboardFlagEntities>({
  key: "asset-profiles",
  adapter: dashboardFlagsAdapter(),
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
