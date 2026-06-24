import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createSdpApiClient } from "@/lib/sdp-api";
import type { OnboardingStatusResponse } from "../../onboarding-status";
import { fetchCounterparties } from "../counterparty/counterparty-page.data";
import { fetchPaymentsIssuedTokenSymbols } from "../payments-page.data";
import { PaymentsActionPage } from "../ramps/ramp-action-page";

export default async function PaymentsPayPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiClient = await createSdpApiClient();
  const [issuedTokenSymbolsResult, onboardingStatus, counterpartiesResult] = await Promise.all([
    fetchPaymentsIssuedTokenSymbols(apiClient.request),
    apiClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status").catch(
      () =>
        ({
          linked: false,
          organization: null,
        }) satisfies OnboardingStatusResponse
    ),
    fetchCounterparties(apiClient.request),
  ]);
  const issuedTokenSymbolsByMint = Object.fromEntries(
    (issuedTokenSymbolsResult.data ?? []).map((token) => [token.mintAddress, token.symbol])
  );
  const providerAccess =
    onboardingStatus.organization &&
    (await fetchProviderAvailability(apiClient.request, onboardingStatus.organization.id).catch(
      () => null
    ));

  return (
    <PaymentsActionPage
      mode="send"
      actionLabel="Pay"
      wallets={[]}
      walletsError={null}
      issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
      enabledComplianceProviders={providerAccess?.enabledComplianceProviders ?? []}
      enabledRampProviders={providerAccess?.enabledRampProviders ?? []}
      counterpartiesResult={counterpartiesResult}
    />
  );
}
