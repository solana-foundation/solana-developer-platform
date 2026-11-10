import { auth } from "@clerk/nextjs/server";
import { isByokCustodyProvider } from "@sdp/types/custody";
import { notFound, redirect } from "next/navigation";
import { AddConnectionFlow } from "@/app/(session)/dashboard/[projectId]/wallets/connections/add-connection-flow";
import { providerSupportsStoredCredentialSetup } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { offersCustodyMode } from "@/lib/provider-availability";
import { fetchProjectProviderAvailability } from "@/lib/provider-availability.server";
import { createSdpApiClient, requestMemberRole, requestProjectHref } from "@/lib/sdp-api";

export default async function NewCustodyConnectionPage({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await params;
  // The provider page's connections gate: only a provider with a self-service
  // credential install, in a project that may set it up in `byok` mode, has
  // connections to add.
  if (!isByokCustodyProvider(provider) || !providerSupportsStoredCredentialSetup(provider)) {
    notFound();
  }
  if (!isModuleInDeploymentReleaseChannel("custody")) {
    notFound();
  }

  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const dashboardAccess = resolveDashboardAccess(await requestMemberRole());
  if (!dashboardAccess.capabilities.canManageCustody) {
    redirect(await requestProjectHref(`/dashboard/integrations/${provider}`));
  }

  const client = await createSdpApiClient();
  if (!offersCustodyMode(await fetchProjectProviderAvailability(client), provider, "byok")) {
    notFound();
  }

  return <AddConnectionFlow provider={provider} />;
}
