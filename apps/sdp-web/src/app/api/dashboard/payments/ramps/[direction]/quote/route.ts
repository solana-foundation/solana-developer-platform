import { NextResponse } from "next/server";
import { createSdpApiClient } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ direction: string }>;
};

async function readParams(context: RouteContext) {
  const resolved = await context.params;
  return resolved.direction;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const direction = await readParams(context);
    if (direction !== "onramp" && direction !== "offramp") {
      return NextResponse.json(
        {
          error: {
            message: "Unsupported ramp quote direction",
          },
        },
        { status: 400 }
      );
    }

    const body = await request.text();
    const apiClient = await createSdpApiClient();
    const response = await apiClient.request(`/v1/payments/ramps/${direction}/quote`, {
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
        error: {
          message: error instanceof Error ? error.message : "Ramp quote request failed",
        },
      },
      { status: 500 }
    );
  }
}
