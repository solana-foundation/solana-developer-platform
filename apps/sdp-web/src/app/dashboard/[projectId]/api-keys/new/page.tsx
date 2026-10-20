import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { grantableActionsInChannel } from "@/app/dashboard/[projectId]/api-keys/api-key-authoring";
import { fetchApiKeyAuthoringWallets } from "@/app/dashboard/[projectId]/api-keys/api-key-authoring.data";
import { ApiKeyAuthoringWorkspace } from "@/app/dashboard/[projectId]/api-keys/api-key-authoring-workspace";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, requestProjectHref } from "@/lib/sdp-api";

export const dynamic = "force-dynamic";

export default async function NewApiKeyPage() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }
  if (!resolveDashboardAccess(orgRole).capabilities.canManageApiKeys) {
    redirect(await requestProjectHref("/dashboard/api-keys"));
  }

  const client = await createSdpApiClient();
  const wallets = await fetchApiKeyAuthoringWallets(client);
  return (
    <ApiKeyAuthoringWorkspace
      mode="create"
      wallets={wallets}
      offeredActions={grantableActionsInChannel(isModuleInDeploymentReleaseChannel)}
    />
  );
}
