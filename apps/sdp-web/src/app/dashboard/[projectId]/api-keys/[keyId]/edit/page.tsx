import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import {
  fetchApiKeyAuthoringWallets,
  fetchApiKeyForAuthoring,
} from "@/app/dashboard/[projectId]/api-keys/api-key-authoring.data";
import { ApiKeyAuthoringWorkspace } from "@/app/dashboard/[projectId]/api-keys/api-key-authoring-workspace";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, requestProjectHref } from "@/lib/sdp-api";

export const dynamic = "force-dynamic";

export default async function EditApiKeyPage({ params }: { params: Promise<{ keyId: string }> }) {
  const [{ userId, orgId, orgRole }, { keyId }] = await Promise.all([auth(), params]);
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
  const [apiKey, wallets] = await Promise.all([
    fetchApiKeyForAuthoring(client, decodeURIComponent(keyId)),
    fetchApiKeyAuthoringWallets(client),
  ]);
  if (!apiKey) {
    notFound();
  }

  return <ApiKeyAuthoringWorkspace mode="edit" wallets={wallets} initialKey={apiKey} />;
}
