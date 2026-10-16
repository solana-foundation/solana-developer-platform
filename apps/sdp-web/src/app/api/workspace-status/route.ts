import { NextResponse } from "next/server";
import { createOrgSdpApiClient, getSdpAuth } from "@/lib/sdp-api";
import { resolveWorkspaceReadiness } from "@/lib/workspace-readiness";

export async function GET() {
  const { userId, orgId } = await getSdpAuth();
  if (!userId || !orgId) return NextResponse.json({ state: "sign-in" }, { status: 401 });
  const result = await resolveWorkspaceReadiness(
    await createOrgSdpApiClient(),
    AbortSignal.timeout(10_000)
  );
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
