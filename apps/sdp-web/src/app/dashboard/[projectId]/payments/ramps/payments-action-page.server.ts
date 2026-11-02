import { loadInstance } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import type { OnboardingStatusResponse } from "@/app/dashboard/[projectId]/onboarding-status";
import { fetchCounterparties } from "@/app/dashboard/[projectId]/payments/counterparty/counterparty-page.data";
import { fetchIssuedTokenSymbolsWhenIssuanceEnabled } from "@/app/dashboard/[projectId]/payments/issued-tokens.server";
import { privateChannels } from "@/flags";
import { getEnabledRampProviders, isRampsEnabled } from "@/flags/ramps";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
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
  const [orgClient, apiClient, rampsOffered] = await Promise.all([
    createOrgSdpApiClient(),
    createSdpApiClient(),
    isRampsEnabled(),
  ]);
  // Provider access serves only Ramps (the fiat rails) and Compliance (address screening), so
  // where neither runs here, its two reads are skipped.
  const providerAccessPromise =
    rampsOffered || isModuleInDeploymentReleaseChannel("compliance")
      ? orgClient
          .fetch<OnboardingStatusResponse>("/v1/onboarding/status")
          .catch(() => UNLINKED_ONBOARDING_STATUS)
          .then((onboardingStatus) =>
            onboardingStatus.organization
              ? fetchProviderAvailability(
                  orgClient.request,
                  onboardingStatus.organization.id
                ).catch(() => null)
              : null
          )
      : Promise.resolve(null);
  const [
    issuedTokenSymbolsResult,
    counterpartiesResult,
    providerAccess,
    enabledRampProviders,
    privateSend,
  ] = await Promise.all([
    fetchIssuedTokenSymbolsWhenIssuanceEnabled(apiClient.request),
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
