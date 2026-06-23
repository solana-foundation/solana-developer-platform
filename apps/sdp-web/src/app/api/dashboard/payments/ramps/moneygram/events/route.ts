import { NextResponse } from "next/server";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function POST(request: Request) {
  try {
    const body = await request.text();
    const apiClient = await createSdpApiClient();
    const response = await apiClient.request("/v1/payments/ramps/moneygram/events", {
      method: "POST",
      body,
    });

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
        error: {
          message: error instanceof Error ? error.message : "MoneyGram ramp event request failed",
        },
      },
      { status: 500 }
    );
  }
}
