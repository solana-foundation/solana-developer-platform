import { redirect } from "next/navigation";
import { requestProjectHref } from "@/lib/sdp-api";

/**
 * Connections moved onto the provider page that owns them, so this route and
 * its `/dashboard/wallets/connections` alias now forward there.
 *
 * Kept as redirects rather than deleted: both URLs shipped and are bookmarked,
 * and a 404 would be a worse answer than the page the user actually wanted.
 */
export default async function CustodyConnectionsRedirect() {
  redirect(await requestProjectHref("/dashboard/integrations/privy"));
}
