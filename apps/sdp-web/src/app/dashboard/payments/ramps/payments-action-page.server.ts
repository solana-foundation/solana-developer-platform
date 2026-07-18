import "server-only";

import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import { fetchCounterparties } from "@/app/dashboard/payments/counterparty/counterparty-page.data";
import { fetchPaymentsIssuedTokenSymbols } from "@/app/dashboard/payments/payments-page.data";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createOrgSdpApiClient, createSdpApiClient } from "@/lib/sdp-api";

const UNLINKED_ONBOARDING_STATUS = {
  linked: false,
  organization: null,
} satisfies OnboardingStatusResponse;

export async function loadPaymentsActionPageData() {
  const [orgClient, apiClient] = await Promise.all([createOrgSdpApiClient(), createSdpApiClient()]);
  const onboardingStatusPromise = orgClient
    .fetch<OnboardingStatusResponse>("/v1/onboarding/status")
    .catch(() => UNLINKED_ONBOARDING_STATUS);
  const providerAccessPromise = onboardingStatusPromise.then((onboardingStatus) =>
    onboardingStatus.organization
      ? fetchProviderAvailability(orgClient.request, onboardingStatus.organization.id).catch(
          () => null
        )
      : null
  );
  const [issuedTokenSymbolsResult, counterpartiesResult, providerAccess] = await Promise.all([
    fetchPaymentsIssuedTokenSymbols(apiClient.request),
    fetchCounterparties(apiClient.request),
    providerAccessPromise,
  ]);

  return {
    issuedTokenSymbolsByMint: Object.fromEntries(
      (issuedTokenSymbolsResult.data ?? []).map((token) => [token.mintAddress, token.symbol])
    ),
    enabledComplianceProviders: providerAccess?.enabledComplianceProviders ?? [],
    rampProviderAccess: providerAccess ? providerAccess.rampProviderAccess : null,
    counterpartiesResult,
  };
}
