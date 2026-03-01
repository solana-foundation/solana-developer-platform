import { createSdpApiClient } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.text();
    const apiClient = await createSdpApiClient();
    const response = await apiClient.request("/v1/compliance/address-screenings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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
        error: error instanceof Error ? error.message : "Compliance request failed",
      },
      { status: 500 }
    );
  }
}
