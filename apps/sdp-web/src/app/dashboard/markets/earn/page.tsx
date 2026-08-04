import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { EarnWorkspace } from "./earn-workspace";

export const dynamic = "force-dynamic";

/**
 * Earn overview — SDP Markets module (V1: Solana Earn). Live data: the
 * workspace reads the shared portfolio program and the synced strategy
 * catalogue through the /api/dashboard/markets/earn BFF proxies (see
 * earn-program-data.ts for the client seam).
 */
export default async function EarnPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return <EarnWorkspace />;
}
