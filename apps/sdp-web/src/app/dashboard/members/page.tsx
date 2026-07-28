import { redirect } from "next/navigation";

/**
 * Members moved into the settings page. This route shipped in production, so
 * it stays as a redirect rather than a deletion — bookmarks and shared links
 * would otherwise 404.
 */
export default function DashboardMembersPage() {
  redirect("/dashboard/settings#members");
}
