import { createSdpApiClient } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const apiClient = await createSdpApiClient();
    const query = new URLSearchParams({ includeAllProviders: "true" }).toString();
    const response = await apiClient.request(`/v1/wallets?${query}`);
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
