import { createSdpApiClient } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const apiClient = await createSdpApiClient();
    const url = new URL(request.url);
    const query = new URLSearchParams(url.searchParams);

    // biome-ignore lint/nursery/noSecrets: Query parameter name, not a secret.
    if (!query.has("includeAllProviders")) {
      // biome-ignore lint/nursery/noSecrets: Query parameter name, not a secret.
      query.set("includeAllProviders", "true");
    }

    const response = await apiClient.request(`/v1/wallets/aggregate?${query.toString()}`);
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
        error: error instanceof Error ? error.message : "Failed to fetch aggregate wallet balances",
      },
      { status: 500 }
    );
  }
}
