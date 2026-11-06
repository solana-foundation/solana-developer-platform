import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { grantableActionsInChannel } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring";
import { fetchApiKeyAuthoringWallets } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring.data";
import { ApiKeyCreateForm } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-create-form";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, requestMemberRole, requestProjectHref } from "@/lib/sdp-api";

export const dynamic = "force-dynamic";

export default async function NewApiKeyPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  if (!resolveDashboardAccess(await requestMemberRole()).capabilities.canManageApiKeys) {
    redirect(await requestProjectHref("/dashboard/api-keys"));
  }

  const client = await createSdpApiClient();
  const wallets = await fetchApiKeyAuthoringWallets(client);
  return (
    <ApiKeyCreateForm
      wallets={wallets}
      offered={grantableActionsInChannel(isModuleInDeploymentReleaseChannel)}
      now={Date.now()}
    />
  );
}
