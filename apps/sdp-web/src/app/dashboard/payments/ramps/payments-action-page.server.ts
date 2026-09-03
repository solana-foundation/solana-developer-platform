import "server-only";

import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import { fetchCounterparties } from "@/app/dashboard/payments/counterparty/counterparty-page.data";
import { fetchPaymentsIssuedTokenSymbols } from "@/app/dashboard/payments/payments-page.data";
import { getEnabledRampProviders } from "@/flags/ramps";
import {
  fetchProviderAvailability,
  filterEnabledRampProviderAccess,
} from "@/lib/provider-availability";
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
  const [issuedTokenSymbolsResult, counterpartiesResult, providerAccess, enabledRampProviders] =
    await Promise.all([
      fetchPaymentsIssuedTokenSymbols(apiClient.request),
      fetchCounterparties(apiClient.request),
      providerAccessPromise,
      getEnabledRampProviders(),
    ]);

  return {
    issuedTokenSymbolsByMint: Object.fromEntries(
      (issuedTokenSymbolsResult.data ?? []).map((token) => [token.mintAddress, token.symbol])
    ),
    enabledComplianceProviders: providerAccess?.enabledComplianceProviders ?? [],
    enabledRampProviders,
    rampProviderAccess: providerAccess
      ? filterEnabledRampProviderAccess(providerAccess.rampProviderAccess, enabledRampProviders)
      : null,
    counterpartiesResult,
  };
}
