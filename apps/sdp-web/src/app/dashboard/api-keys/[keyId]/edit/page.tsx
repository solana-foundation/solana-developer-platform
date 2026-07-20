import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchApiKeyAuthoringWallets, fetchApiKeyForAuthoring } from "../../api-key-authoring.data";
import { ApiKeyAuthoringWorkspace } from "../../api-key-authoring-workspace";

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
    redirect("/dashboard/api-keys");
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
