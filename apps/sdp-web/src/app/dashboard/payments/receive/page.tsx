import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createSdpApiClient } from "@/lib/sdp-api";
import type { OnboardingStatusResponse } from "../../onboarding-status";
import { PaymentsActionPage } from "../payments-action-page";
import { fetchPaymentsIssuedTokenSymbols } from "../payments-page.data";

export default async function PaymentsReceivePage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiClient = await createSdpApiClient();
  const [issuedTokenSymbolsResult, onboardingStatus] = await Promise.all([
    fetchPaymentsIssuedTokenSymbols(apiClient.request),
    apiClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status").catch(
      () =>
        ({
          linked: false,
          organization: null,
        }) satisfies OnboardingStatusResponse
    ),
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
      mode="receive"
      wallets={[]}
      walletsError={null}
      issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
      enabledComplianceProviders={providerAccess?.enabledComplianceProviders ?? []}
      enabledRampProviders={providerAccess?.enabledRampProviders ?? []}
    />
  );
}
