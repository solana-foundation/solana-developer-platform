import { normalizeWorkspaceReturnPath } from "@/lib/workspace-loading";
import { WorkspaceLoadingRefresh } from "./workspace-loading-refresh";

export default async function WorkspaceLoadingPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string | string[] }>;
}) {
  const { return_to: returnTo } = await searchParams;
  return <WorkspaceLoadingRefresh returnTo={normalizeWorkspaceReturnPath(returnTo)} />;
}
