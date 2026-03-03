import { createSdpApiClient } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const apiClient = await createSdpApiClient();
    const response = await apiClient.request("/v1/wallets?includeAllProviders=true");
    const body = await response.text();
    const contentType = response.headers.get("Content-Type") ?? "application/json";

    return new NextResponse(body, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch wallets",
      },
      { status: 500 }
    );
  }
}
