import { vercelAdapter } from "@flags-sdk/vercel";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { dedupe } from "flags/next";
import { getSdpAuth } from "@/lib/sdp-api";
import { type DashboardFlagEntities, defineDashboardFlags } from "./definitions";
import { deploymentReleaseChannel } from "./release-channel";

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

// Only flag definitions may be exported here: the flags discovery endpoint serves this module wholesale.
const flags = defineDashboardFlags({
  releaseChannel: deploymentReleaseChannel(),
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
  vercel: () => vercelAdapter<boolean, DashboardFlagEntities>(),
  identify: identifyDashboardEntities,
});

export const {
  homepageOpenSignup,
  custody,
  issuance,
  policies,
  privyByok,
  assetProfiles,
  privateChannels,
  heliusRings,
  payments,
  markets,
  dvp,
  earn,
  newDesign,
  rampProviderMoonpay,
  rampProviderLightspark,
  rampProviderBvnk,
  rampProviderMoneygram,
  rampProviderCoinbase,
  rampProviderMural,
  rampProviderStripe,
} = flags;
