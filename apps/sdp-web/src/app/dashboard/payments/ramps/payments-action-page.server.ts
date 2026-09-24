import "server-only";

import { loadInstance } from "@/app/dashboard/integrations/private-channels/private-channels-page.data";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import { fetchCounterparties } from "@/app/dashboard/payments/counterparty/counterparty-page.data";
import { fetchPaymentsIssuedTokenSymbols } from "@/app/dashboard/payments/payments-page.data";
import { privateChannels } from "@/flags";
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

/**
 * Whether the project can send privately, for Pay's notice: null when Private Channels is off,
 * otherwise whether an instance is active. A failed read counts as not connected.
 */
async function loadPrivateSendStatus(
  apiClient: Awaited<ReturnType<typeof createSdpApiClient>>
): Promise<{ enabled: boolean; connected: boolean } | null> {
  if (!(await privateChannels())) return null;
  const instance = await loadInstance(apiClient);
  return { enabled: true, connected: instance.ok && instance.data?.isActive === true };
}

export async function loadPaymentsActionPageData(
  options: { includePrivateSendStatus?: boolean } = {}
) {
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
  const [
    issuedTokenSymbolsResult,
    counterpartiesResult,
    providerAccess,
    enabledRampProviders,
    privateSend,
  ] = await Promise.all([
    fetchPaymentsIssuedTokenSymbols(apiClient.request),
    fetchCounterparties(apiClient.request),
    providerAccessPromise,
    getEnabledRampProviders(),
    options.includePrivateSendStatus ? loadPrivateSendStatus(apiClient) : null,
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
    privateSend,
  };
}
