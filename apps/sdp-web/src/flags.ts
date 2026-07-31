import { vercelAdapter } from "@flags-sdk/vercel";
import { dedupe, flag } from "flags/next";
import { getSdpAuth } from "@/lib/sdp-api";

type DashboardFlagEntities = {
  user?: {
    email: string;
  };
};

/**
 * Resolves the entities Vercel Flags targeting rules match against: the
 * signed-in user's email. Signed-out sessions resolve to no entities, so only
 * default/environment rules apply.
 *
 * The email is read from the session token, which requires an `email` custom
 * claim configured per Clerk instance under Clerk Dashboard → Sessions →
 * Customize session token.
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
    throw new Error(
      "Clerk session token is missing the `email` claim. Add it under Clerk Dashboard → Sessions → Customize session token."
    );
  }

  return {
    user: { email },
  };
});

export const homepageOpenSignup = flag<boolean, DashboardFlagEntities>({
  key: "homepage-open-signup",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: true,
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
  defaultValue: true,
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
  defaultValue: false,
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
  defaultValue: true,
  description: "Show the Asset Profiles issuance wizard and per-token asset management workspace.",
  options: [
    { value: false, label: "Legacy issuance" },
    { value: true, label: "Asset Profiles" },
  ],
});
