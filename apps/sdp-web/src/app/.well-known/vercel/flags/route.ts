import { getProviderData } from "@flags-sdk/vercel";
import { createFlagsDiscoveryEndpoint } from "flags/next";
import type { NextRequest } from "next/server";
import * as flags from "@/flags";

const discoveryEndpoint = createFlagsDiscoveryEndpoint(async () => getProviderData(flags));

// Flag definitions are deployment metadata for the Flags Explorer, not public
// API surface: this well-known route has no auth of its own, so production
// answers 404 rather than let anonymous callers enumerate enabled features.
// Development and preview keep the endpoint for Vercel Toolbar tooling.
export async function GET(request: NextRequest): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }
  return discoveryEndpoint(request);
}
