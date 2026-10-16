import { redirect } from "next/navigation";
import { requestProjectHref } from "@/lib/sdp-api";

/**
 * Members moved into the settings page. This route shipped in production, so
 * it stays as a redirect rather than a deletion — bookmarks and shared links
 * would otherwise 404.
 */
export default async function DashboardMembersPage() {
  redirect(await requestProjectHref("/dashboard/settings#members"));
}
