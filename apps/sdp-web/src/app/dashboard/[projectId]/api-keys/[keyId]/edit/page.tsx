import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { projectHref } from "@/lib/dashboard-project-path";
import { createProjectBoundSdpApiClient } from "@/lib/sdp-api";
import { fetchApiKeyAuthoringWallets, fetchApiKeyForAuthoring } from "../../api-key-authoring.data";
import { ApiKeyAuthoringWorkspace } from "../../api-key-authoring-workspace";

export const dynamic = "force-dynamic";

export default async function EditApiKeyPage({
  params,
}: {
  params: Promise<{ projectId: string; keyId: string }>;
}) {
  const [{ userId, orgId, orgRole }, { projectId, keyId }] = await Promise.all([auth(), params]);
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
  const [apiKey, authoringWallets] = await Promise.all([
    fetchApiKeyForAuthoring(client, decodeURIComponent(keyId)),
    fetchApiKeyAuthoringWallets(client, {
      policiesInReleaseChannel: isModuleInDeploymentReleaseChannel("policies"),
    }),
  ]);
  if (!apiKey) {
    notFound();
  }

  return (
    <ApiKeyAuthoringWorkspace mode="edit" authoringWallets={authoringWallets} initialKey={apiKey} />
  );
}
