import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { grantableActionsInChannel } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring";
import {
  fetchApiKeyAuthoringWallets,
  fetchApiKeyDetails,
} from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring.data";
import { ApiKeyDetailView } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-detail-view";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, requestMemberRole } from "@/lib/sdp-api";
import { findPublicSdpApiBaseUrl } from "@/lib/sdp-api-base-url";

export const dynamic = "force-dynamic";

export default async function ApiKeyPage({ params }: { params: Promise<{ keyId: string }> }) {
  const [{ orgId }, { keyId }] = await Promise.all([auth(), params]);
  if (!orgId) {
    redirect("/dashboard");
  }

  const { canManageApiKeys } = resolveDashboardAccess(await requestMemberRole()).capabilities;
  const client = await createSdpApiClient();
  const [apiKey, wallets] = await Promise.all([
    fetchApiKeyDetails(client, decodeURIComponent(keyId)),
    fetchApiKeyAuthoringWallets(client),
  ]);
  if (!apiKey) {
    notFound();
  }

  return (
    <ApiKeyDetailView
      apiKey={apiKey}
      wallets={wallets}
      offered={grantableActionsInChannel(isModuleInDeploymentReleaseChannel)}
      canManageApiKeys={canManageApiKeys}
      apiBaseUrl={findPublicSdpApiBaseUrl({
        NEXT_PUBLIC_SDP_API_BASE_URL: process.env.NEXT_PUBLIC_SDP_API_BASE_URL,
        NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
      })}
      now={Date.now()}
    />
  );
}
