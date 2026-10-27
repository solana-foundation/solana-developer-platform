import { redirect } from "next/navigation";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { requestMemberRole, requestProjectHref } from "@/lib/sdp-api";

/**
 * Sends a read-only member (`viewer`) away from a page whose only purpose is to change state,
 * such as a "new X" flow. The API refuses every write for them, so the form would only fail.
 *
 * @param fallbackPath The project-relative page to land on instead, e.g. the list the flow
 *   creates into.
 */
export async function redirectUnlessCanWrite(fallbackPath: string): Promise<void> {
  if (!resolveDashboardAccess(await requestMemberRole()).capabilities.canWrite) {
    redirect(await requestProjectHref(fallbackPath));
  }
}
