import { vercelAdapter } from "@flags-sdk/vercel";
import { dedupe, flag } from "flags/next";
import { getSdpAuth } from "@/lib/sdp-api";

type DashboardFlagEntities = {
  user?: {
    email: string;
  };
};

const TRUTHY_FLAG_VALUES = ["1", "true", "yes", "on"] as const;
const FALSY_FLAG_VALUES = ["0", "false", "no", "off"] as const;

/** Reads a flag's non-Vercel default from an optional env var override; the dashboard wins on Vercel deploys. */
function flagDefault(envVar: string, fallback: boolean): boolean {
  const value = process.env[envVar];
  if (value === undefined || value === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if ((TRUTHY_FLAG_VALUES as readonly string[]).includes(normalized)) {
    return true;
  }
  if ((FALSY_FLAG_VALUES as readonly string[]).includes(normalized)) {
    return false;
  }
  throw new Error(`${envVar} must be a boolean-like value, got "${value}"`);
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

export const alphaledgerTokenizationEngine = flag<boolean, DashboardFlagEntities>({
  key: "alphaledger-tokenization-engine",
  adapter: vercelAdapter(),
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
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: flagDefault("SDP_FLAG_ASSET_PROFILES", true),
  description: "Show the Asset Profiles issuance wizard and per-token asset management workspace.",
  options: [
    { value: false, label: "Legacy issuance" },
    { value: true, label: "Asset Profiles" },
  ],
});
