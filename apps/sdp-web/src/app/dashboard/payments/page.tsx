import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { PaymentsWorkspace } from "./payments-workspace";

export default async function PaymentsPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiBaseUrl = resolvePlaygroundApiBaseUrl();
  const apiClient = await createSdpApiClient();
  const apiKeysResult = await fetchActiveApiKeys(apiClient.request);
  const apiKeys = apiKeysResult.data ?? [];

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PaymentsWorkspace apiBaseUrl={apiBaseUrl} apiKeys={apiKeys} />
    </div>
  );
}
