import { auth } from "@clerk/nextjs/server";
import { vercelAdapter } from "@flags-sdk/vercel";
import { dedupe, flag } from "flags/next";
import { getAssetProfilesDefault, getHomepageOpenSignupDefault } from "@/lib/feature-flag-defaults";

type DashboardFlagEntities = {
  user?: {
    id: string;
  };
  team?: {
    id: string;
    role?: string;
  };
};

const identifyDashboardEntities = dedupe(async (): Promise<DashboardFlagEntities> => {
  const { orgId, orgRole, userId } = await auth();

  return {
    user: userId ? { id: userId } : undefined,
    team: orgId
      ? {
          id: orgId,
          role: orgRole ?? undefined,
        }
      : undefined,
  };
});

export const homepageOpenSignup = flag<boolean>({
  key: "homepage-open-signup",
  adapter: vercelAdapter(),
  defaultValue: getHomepageOpenSignupDefault({
    vercelEnvironment: process.env.VERCEL_ENV,
  }),
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

export const assetProfiles = flag<boolean, DashboardFlagEntities>({
  key: "asset-profiles",
  adapter: vercelAdapter(),
  identify: identifyDashboardEntities,
  defaultValue: getAssetProfilesDefault({
    nodeEnvironment: process.env.NODE_ENV,
    sdpEnvironment: process.env.NEXT_PUBLIC_SDP_ENVIRONMENT,
    vercelEnvironment: process.env.VERCEL_ENV,
  }),
  description: "Show the Asset Profiles issuance wizard and per-token asset management workspace.",
  options: [
    { value: false, label: "Legacy issuance" },
    { value: true, label: "Asset Profiles" },
  ],
});
