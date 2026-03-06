import { createSdpApiClient } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const apiClient = await createSdpApiClient();
    const url = new URL(request.url);
    const search = url.searchParams.toString();
    const response = await apiClient.request(
      `/v1/payments/transfers${search ? `?${search}` : ""}`,
      {
        method: "GET",
      }
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
        error: error instanceof Error ? error.message : "Transfer list request failed",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.text();
    const apiClient = await createSdpApiClient();
    const response = await apiClient.request("/v1/payments/transfers", {
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
        error: error instanceof Error ? error.message : "Transfer request failed",
      },
      { status: 500 }
    );
  }
}
