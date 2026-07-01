import { NextResponse } from "next/server";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request) {
  try {
    const apiClient = await createSdpApiClient();
    const search = new URL(request.url).searchParams.toString();
    const response = await apiClient.request(
      `/v1/counterparties/accounts${search ? `?${search}` : ""}`,
      { method: "GET" }
    );

    const responseBody = await response.text();
    const contentType = response.headers.get("Content-Type") ?? "application/json";

    return new NextResponse(responseBody, {
      status: response.status,
      headers: { "Content-Type": contentType },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Recipient lookup failed",
        },
      },
      { status: 500 }
    );
  }
}
