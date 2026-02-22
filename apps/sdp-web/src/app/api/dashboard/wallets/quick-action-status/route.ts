import { createSdpApiClient } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

interface OnboardingStatusResponse {
  linked: boolean;
}

interface WalletConfigResponse {
  config: {
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
      });
    }

    if (configResponse.status === 404) {
      return NextResponse.json({
        custodyEnabled: false,
      });
    }

    if (!configResponse.ok) {
      const body = await configResponse.text();
      throw new Error(`SDP API request failed (${configResponse.status}): ${body}`);
    }

    const parsed = (await configResponse.json()) as { data?: WalletConfigResponse };
    const custodyEnabled = parsed.data?.config.status === "active";

    return NextResponse.json({
      custodyEnabled,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to resolve wallet quick action status",
      },
      { status: 500 }
    );
  }
}
