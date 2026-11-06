import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { grantableActionsInChannel } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring";
import {
  fetchApiKeyAuthoringWallets,
  fetchApiKeyForAuthoring,
} from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring.data";
import { ApiKeyAuthoringWorkspace } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring-workspace";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, requestMemberRole, requestProjectHref } from "@/lib/sdp-api";

export const dynamic = "force-dynamic";

export default async function EditApiKeyPage({ params }: { params: Promise<{ keyId: string }> }) {
  const [{ orgId }, { keyId }] = await Promise.all([auth(), params]);
  if (!orgId) {
    redirect("/dashboard");
  }
  if (!resolveDashboardAccess(await requestMemberRole()).capabilities.canManageApiKeys) {
    redirect(await requestProjectHref("/dashboard/api-keys"));
  }

  const client = await createSdpApiClient();
  const [apiKey, wallets] = await Promise.all([
    fetchApiKeyForAuthoring(client, decodeURIComponent(keyId)),
    fetchApiKeyAuthoringWallets(client),
  ]);
  if (!apiKey) {
    notFound();
  }

  return (
    <ApiKeyAuthoringWorkspace
      mode="edit"
      wallets={wallets}
      offeredActions={grantableActionsInChannel(isModuleInDeploymentReleaseChannel)}
      initialKey={apiKey}
    />
  );
}
