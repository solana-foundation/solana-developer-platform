import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { projectHref } from "@/lib/dashboard-project-path";
import { createProjectBoundSdpApiClient } from "@/lib/sdp-api";
import { fetchApiKeyAuthoringWallets } from "../api-key-authoring.data";
import { ApiKeyAuthoringWorkspace } from "../api-key-authoring-workspace";

export const dynamic = "force-dynamic";

export default async function NewApiKeyPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const [{ projectId }, { userId, orgId, orgRole }] = await Promise.all([params, auth()]);
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }
  if (!resolveDashboardAccess(orgRole).capabilities.canManageApiKeys) {
    redirect(projectHref(projectId, "/dashboard/api-keys"));
  }

  const client = await createProjectBoundSdpApiClient(projectId);
  // Wallet controls follow the Policies module, as the API does, not the per-user policies flag.
  const authoringWallets = await fetchApiKeyAuthoringWallets(client, {
    policiesInReleaseChannel: isModuleInDeploymentReleaseChannel("policies"),
  });
  return <ApiKeyAuthoringWorkspace mode="create" authoringWallets={authoringWallets} />;
}
