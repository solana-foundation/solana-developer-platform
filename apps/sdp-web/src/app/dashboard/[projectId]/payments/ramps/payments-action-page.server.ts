import "server-only";

import type { OnboardingStatusResponse } from "@/app/dashboard/[projectId]/onboarding-status";
import { fetchCounterparties } from "@/app/dashboard/[projectId]/payments/counterparty/counterparty-page.data";
import { fetchPaymentsIssuedTokenSymbols } from "@/app/dashboard/[projectId]/payments/payments-page.data";
import { getEnabledRampProviders } from "@/flags/ramps";
import {
  fetchProviderAvailability,
  filterEnabledRampProviderAccess,
} from "@/lib/provider-availability";
import { createOrgSdpApiClient, createProjectBoundSdpApiClient } from "@/lib/sdp-api";

const UNLINKED_ONBOARDING_STATUS = {
  linked: false,
  organization: null,
} satisfies OnboardingStatusResponse;

/**
 * Loads the data the Pay and Deposit action pages share: issued token symbols,
 * counterparties, compliance/ramp provider access, and the enabled ramp providers.
 *
 * @param projectId - Project the page renders, from its URL.
 * @returns Props spread into `PaymentsActionPage`.
 */
export async function loadPaymentsActionPageData(projectId: string) {
  const [orgClient, apiClient] = await Promise.all([
    createOrgSdpApiClient(),
    createProjectBoundSdpApiClient(projectId),
  ]);
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
