import { redirect } from "next/navigation";
import { projectHref } from "@/lib/dashboard-project-path";

/**
 * Connections moved onto the provider page that owns them, so this route and
 * its `/dashboard/wallets/connections` alias now forward there.
 *
 * Kept as redirects rather than deleted: both URLs shipped and are bookmarked,
 * and a 404 would be a worse answer than the page the user actually wanted.
 */
export default async function CustodyConnectionsRedirect({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(projectHref(projectId, "/dashboard/integrations/privy"));
}
