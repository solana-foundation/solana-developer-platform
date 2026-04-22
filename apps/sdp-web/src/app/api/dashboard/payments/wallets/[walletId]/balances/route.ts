import { NextResponse } from "next/server";
import { createSdpApiClient } from "@/lib/sdp-api";

async function readParams(context: { params: Promise<{ walletId: string }> }) {
  const resolved = await context.params;
  return resolved.walletId;
}

export async function GET(_request: Request, context: { params: Promise<{ walletId: string }> }) {
  try {
    const walletId = await readParams(context);
    const apiClient = await createSdpApiClient();
    const response = await apiClient.request(
      `/v1/payments/wallets/${encodeURIComponent(walletId)}/balances`
    );

    const responseBody = await response.text();
    const contentType = response.headers.get("Content-Type") ?? "application/json";

    return new NextResponse(responseBody, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch wallet balances",
      },
      { status: 500 }
    );
  }
}
