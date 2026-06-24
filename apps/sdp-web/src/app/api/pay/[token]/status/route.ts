import { NextResponse } from "next/server";
import { resolvePlaygroundApiBaseUrl } from "@/app/dashboard/playground-api-data";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const apiBaseUrl = resolvePlaygroundApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error("SDP API base URL is not configured");
  }

  const response = await fetch(`${apiBaseUrl}/pay/${encodeURIComponent(token)}/status`, {
    cache: "no-store",
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
