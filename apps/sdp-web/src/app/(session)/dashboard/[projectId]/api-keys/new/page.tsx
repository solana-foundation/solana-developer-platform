import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { grantableActionsInChannel } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { requestMemberRole, requestProjectHref } from "@/lib/sdp-api";
import { NewApiKeyWorkspace } from "./new-api-key-workspace";

export const dynamic = "force-dynamic";

export default async function NewApiKeyPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  if (!resolveDashboardAccess(await requestMemberRole()).capabilities.canManageApiKeys) {
    redirect(await requestProjectHref("/dashboard/api-keys"));
  }
  return (
    <NewApiKeyWorkspace
      offeredActions={grantableActionsInChannel(isModuleInDeploymentReleaseChannel)}
    />
  );
}
