import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PROJECT_COOKIE_NAME,
  PROJECT_COOKIE_OPTIONS,
  WORKSPACE_SCOPE_COOKIE_NAME,
  workspaceScope,
} from "@/lib/project-cookie";
import { createOrgSdpApiClient, getSdpAuth } from "@/lib/sdp-api";
import { resolveWorkspaceReadiness } from "@/lib/workspace-readiness";

export async function GET() {
  const { userId, orgId } = await getSdpAuth();
  if (!userId || !orgId) return NextResponse.json({ state: "sign-in" }, { status: 401 });
  const store = await cookies();
  const result = await resolveWorkspaceReadiness(
    await createOrgSdpApiClient(),
    store.get(PROJECT_COOKIE_NAME)?.value ?? null,
    AbortSignal.timeout(10_000)
  );
  const response = NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  if (result.state === "ready") {
    response.cookies.set(PROJECT_COOKIE_NAME, result.projectId, PROJECT_COOKIE_OPTIONS);
    response.cookies.set(
      WORKSPACE_SCOPE_COOKIE_NAME,
      workspaceScope(userId, orgId, result.projectId),
      PROJECT_COOKIE_OPTIONS
    );
  }
  return response;
}
