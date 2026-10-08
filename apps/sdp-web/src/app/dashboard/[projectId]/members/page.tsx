import { redirect } from "next/navigation";
import { projectHref } from "@/lib/dashboard-project-path";

/**
 * Members moved into the settings page. This route shipped in production, so
 * it stays as a redirect rather than a deletion — bookmarks and shared links
 * would otherwise 404.
 */
export default async function DashboardMembersPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(projectHref(projectId, "/dashboard/settings#members"));
}
