import {
  CUSTODY_PROVIDER_CATALOG,
  type KnownCustodyProvider,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { createSdpApiClient } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

interface OnboardingStatusResponse {
  linked: boolean;
}

interface WalletConfigsResponse {
  configs: Array<{
    provider: string;
    status: "active" | "inactive";
  }>;
}

function formatProviderHint(providerLabels: string[]): string {
  if (providerLabels.length === 0) {
    return "wallet providers";
  }
  if (providerLabels.length === 1) {
    return providerLabels[0] ?? "wallet providers";
  }
  if (providerLabels.length === 2) {
    return `${providerLabels[0]} or ${providerLabels[1]}`;
  }

  const head = providerLabels.slice(0, -1).join(", ");
  const tail = providerLabels[providerLabels.length - 1];
  return `${head}, or ${tail}`;
}

export async function GET() {
  try {
    const apiClient = await createSdpApiClient();
    const [onboarding, configsResponse] = await Promise.all([
      apiClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status"),
      apiClient.request("/v1/wallets/configs"),
    ]);

    if (!onboarding.linked) {
      return NextResponse.json({
        custodyEnabled: false,
        walletProvisioningEnabled: false,
        walletProvisioningReason: "Enable wallets first in the custody providers section.",
        walletProvisioningProviders: [] as KnownCustodyProvider[],
      });
    }

    if (configsResponse.status === 404) {
      return NextResponse.json({
        custodyEnabled: false,
        walletProvisioningEnabled: false,
        walletProvisioningReason: "Enable wallets first in the custody providers section.",
        walletProvisioningProviders: [] as KnownCustodyProvider[],
      });
    }

    if (!configsResponse.ok) {
      const body = await configsResponse.text();
      throw new Error(`SDP API request failed (${configsResponse.status}): ${body}`);
    }

    const parsed = (await configsResponse.json()) as { data?: WalletConfigsResponse };
    const connectedProviders = (parsed.data?.configs ?? [])
      .filter((config) => config.status === "active")
      .map((config) => config.provider)
      .filter(isKnownCustodyProvider);
    const connectedProviderSet = new Set<KnownCustodyProvider>(connectedProviders);

    const walletProvisioningProviders = CUSTODY_PROVIDER_CATALOG.filter(
      (provider) => provider.supportsAdditionalWallets && connectedProviderSet.has(provider.id)
    ).map((provider) => provider.id);
    const additionalWalletProviderLabels = CUSTODY_PROVIDER_CATALOG.filter(
      (provider) => provider.supportsAdditionalWallets
    ).map((provider) => provider.label);

    const custodyEnabled = connectedProviderSet.size > 0;
    const walletProvisioningEnabled = walletProvisioningProviders.length > 0;
    const walletProvisioningReason = walletProvisioningEnabled
      ? ""
      : custodyEnabled
        ? `Connect ${formatProviderHint(additionalWalletProviderLabels)} to create additional wallets.`
        : "Enable wallets first in the custody providers section.";

    return NextResponse.json({
      custodyEnabled,
      walletProvisioningEnabled,
      walletProvisioningReason,
      walletProvisioningProviders,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to resolve wallet quick action status",
      },
      { status: 500 }
    );
  }
}
