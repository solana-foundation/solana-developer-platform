import { auth } from "@clerk/nextjs/server";
import {
  type CustodyProvider,
  GENERAL_PROVIDER_DEFAULTS,
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationRpcProvider,
} from "@sdp/types";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createRequestScopedSdpApiClients } from "@/lib/sdp-api";
import type { OnboardingStatusResponse } from "../onboarding-status";
import { OrganizationOnboardingFlow } from "./organization-onboarding-flow";
import { OrganizationPreparingLoader } from "./organization-preparing-loader";

const GENERAL_CUSTODY_PROVIDERS = Object.entries(GENERAL_PROVIDER_DEFAULTS.custody)
  .filter(([, enabled]) => enabled)
  .map(([provider]) => provider as CustodyProvider);

const GENERAL_RPC_PROVIDERS = ORGANIZATION_RPC_PROVIDERS.filter(
  (provider) => provider !== "default" && GENERAL_PROVIDER_DEFAULTS.rpc[provider]
);

export default async function OrganizationOnboardingPage() {
  const t = await getTranslations();
  const { getToken, userId, orgId } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const { organizationClient } = await createRequestScopedSdpApiClients({ getToken });
  const status = await organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status");

  if (!status.linked || !status.organization || !status.setup) {
    return <OrganizationPreparingLoader />;
  }
  if (status.setup.status === "complete") redirect("/dashboard");

  if (!status.setup.canManage) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-lg rounded-2xl border border-border-default bg-surface-raised p-6 text-center">
          <h1 className="text-xl font-medium text-primary">
            {t("DashboardCustody.onboardingAdminTitle")}
          </h1>
          <p className="mt-2 text-sm leading-6 text-tertiary">
            {t("DashboardCustody.onboardingAdminDescription")}
          </p>
        </div>
      </div>
    );
  }

  const availability = await fetchProviderAvailability(
    organizationClient.request,
    status.organization.id
  );
  const custodyProviders = GENERAL_CUSTODY_PROVIDERS.filter(
    (provider) => availability.providers.custody[provider]?.configured
  );

  return (
    <OrganizationOnboardingFlow
      organizationId={status.organization.id}
      currentStep={status.setup.currentStep === "custody" ? "custody" : "rpc"}
      initialRpcProvider={status.setup.rpcProvider}
      rpcProviders={[...GENERAL_RPC_PROVIDERS] as OrganizationRpcProvider[]}
      custodyProviders={[...custodyProviders]}
    />
  );
}
