import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { isEarnUiEnabled } from "@/lib/earn-feature";
import { EarnWorkspace } from "./earn-workspace";

export const dynamic = "force-dynamic";

/**
 * Earn overview — SDP Markets module (V1: Solana Earn). Currently backed by
 * mock fixtures (see earn-mock-data.ts, the single data seam); the
 * /api/dashboard/markets/earn BFF routes are already stubbed for the swap to live
 * /v1/earn data once the first vault-infra provider sync lands.
 */
export default async function EarnPage() {
  if (!isEarnUiEnabled()) {
    redirect("/dashboard");
  }

  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return <EarnWorkspace />;
}
