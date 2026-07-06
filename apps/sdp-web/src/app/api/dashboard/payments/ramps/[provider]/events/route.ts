import { RAMP_EVENT_PROVIDERS } from "@sdp/types";
import { NextResponse } from "next/server";
import { createSdpApiClient } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { provider } = await context.params;
    if (!(RAMP_EVENT_PROVIDERS as readonly string[]).includes(provider)) {
      return NextResponse.json(
        {
          error: {
            message: "Unsupported ramp event provider",
          },
        },
        { status: 400 }
      );
    }

    const body = await request.text();
    const apiClient = await createSdpApiClient();
    const response = await apiClient.request(`/v1/payments/ramps/${provider}/events`, {
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
          message: error instanceof Error ? error.message : "Ramp event request failed",
        },
      },
      { status: 500 }
    );
  }
}
