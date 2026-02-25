import { createSdpApiClient } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

interface OnboardingStatusResponse {
  linked: boolean;
}

interface WalletConfigResponse {
  config: {
    provider: "privy" | "local" | "fireblocks" | "coinbase_cdp" | "para" | "turnkey";
    status: "active" | "inactive";
  };
}

export async function GET() {
  try {
    const apiClient = await createSdpApiClient();
    const [onboarding, configResponse] = await Promise.all([
      apiClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status"),
      apiClient.request("/v1/wallets/config"),
    ]);

    if (!onboarding.linked) {
      return NextResponse.json({
        custodyEnabled: false,
        walletProvisioningEnabled: false,
        walletProvisioningReason: "Enable wallets first in the Signing configuration section.",
      });
    }

    if (configResponse.status === 404) {
      return NextResponse.json({
        custodyEnabled: false,
        walletProvisioningEnabled: false,
        walletProvisioningReason: "Enable wallets first in the Signing configuration section.",
      });
    }

    if (!configResponse.ok) {
      const body = await configResponse.text();
      throw new Error(`SDP API request failed (${configResponse.status}): ${body}`);
    }

    const parsed = (await configResponse.json()) as { data?: WalletConfigResponse };
    const config = parsed.data?.config;
    const custodyEnabled = config?.status === "active";
    const walletProvisioningSupportedProviders = new Set([
      "privy",
      "coinbase_cdp",
      "para",
      "turnkey",
    ]);
    const walletProvisioningEnabled =
      custodyEnabled &&
      typeof config?.provider === "string" &&
      walletProvisioningSupportedProviders.has(config.provider);
    const walletProvisioningReason = walletProvisioningEnabled
      ? ""
      : custodyEnabled
        ? `Provider '${config?.provider ?? "unknown"}' does not support additional wallet provisioning yet.`
        : "Enable wallets first in the Signing configuration section.";

    return NextResponse.json({
      custodyEnabled,
      walletProvisioningEnabled,
      walletProvisioningReason,
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
