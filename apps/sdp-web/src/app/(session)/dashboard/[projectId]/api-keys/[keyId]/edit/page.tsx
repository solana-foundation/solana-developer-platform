import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { grantableActionsInChannel } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { requestMemberRole, requestProjectHref } from "@/lib/sdp-api";
import { EditApiKeyWorkspace } from "./edit-api-key-workspace";

export default async function EditApiKeyPage({ params }: { params: Promise<{ keyId: string }> }) {
  const [{ orgId }, { keyId }] = await Promise.all([auth(), params]);
  if (!orgId) {
    redirect("/dashboard");
  }
  if (!resolveDashboardAccess(await requestMemberRole()).capabilities.canManageApiKeys) {
    redirect(await requestProjectHref("/dashboard/api-keys"));
  }
  return (
    <EditApiKeyWorkspace
      keyId={decodeURIComponent(keyId)}
      offeredActions={grantableActionsInChannel(isModuleInDeploymentReleaseChannel)}
    />
  );
}
