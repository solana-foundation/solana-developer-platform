import { auth } from "@clerk/nextjs/server";
import type {
  CustodyConfigSummary,
  OrganizationRpcProvider,
  RpcConnectionListResponse,
} from "@sdp/types";
import { ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { isKnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import {
  createRequestScopedSdpApiClients,
  createSdpApiClient,
  type SdpApiClient,
} from "@/lib/sdp-api";
import { isKnownIntegrationProvider, resolveIntegrationDetail } from "../integration-detail";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
  resolveRpcIntegrations,
} from "../integrations-status";
import { IntegrationDetailView } from "./integration-detail-view";

async function getConnectedCustodyProviders(request: SdpApiClient["request"]) {
  const res = await request("/v1/wallets/configs");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data: { configs: CustodyConfigSummary[] } };
  return json.data.configs
    .filter((config) => config.status === "active")
    .map((config) => config.provider)
    .filter(isKnownCustodyProvider);
}

/**
 * Tenant connections for one provider. Read through the session client because
 * the internal routes refuse API keys; a failure is not fatal to the page, it
 * just means the BYOK section has nothing to show.
 */
const CONNECTION_PAGE_SIZE = 50;

/**
 * Tenant connections for one provider.
 *
 * Pages to the end before filtering: the list is organization-wide, so
 * truncating at one page and then narrowing by provider would hide credentials
 * that exist but sit past the cut.
 *
 * Returns `null` when the read fails rather than an empty array. An empty array
 * means "you have none and are running on SDP's", which is a claim we cannot
 * make from a failed request.
 */
async function getByokConnections(provider: string, canManage: boolean) {
  // `default` is SDP's own rail and has no tenant credential; every other RPC
  // provider does. Checked here rather than importing @sdp/rpc, which the web
  // app deliberately does not depend on.
  if (provider === "default" || !ORGANIZATION_RPC_PROVIDERS.includes(provider as never)) {
    return undefined;
  }

  // The internal routes are org:admin for reads as well as writes, so asking on
  // a member's behalf returns 403 every time and the section told them to
  // reload something that was never going to load. Not permitted is its own
  // answer, not a failed request.
  if (!canManage) {
    return "restricted" as const;
  }

  try {
    const client = await createSdpApiClient();
    const collected: RpcConnectionListResponse["connections"] = [];
    let offset = 0;
    let total = 0;

    do {
      const payload = await client.fetch<RpcConnectionListResponse>(
        `/internal/dashboard/rpc/connections?scope=organization&limit=${CONNECTION_PAGE_SIZE}&offset=${offset}`
      );
      collected.push(...payload.connections);
      total = payload.pagination.total;
      offset += CONNECTION_PAGE_SIZE;
      // A page that comes back short means the list ended, whatever total says.
      if (payload.connections.length < CONNECTION_PAGE_SIZE) {
        break;
      }
    } while (collected.length < total);

    return collected.filter((connection) => connection.provider === provider);
  } catch {
    return null;
  }
}

export default async function IntegrationDetailPage({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await params;
  if (!isKnownIntegrationProvider(provider)) {
    notFound();
  }

  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }
  const dashboardAccess = resolveDashboardAccess(orgRole);

  const { organizationClient, projectClient } = await createRequestScopedSdpApiClients();
  const onboarding =
    await organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
  if (!onboarding.linked || !onboarding.organization) {
    redirect("/dashboard");
  }
  if (!projectClient) {
    throw new Error("Selected project required");
  }
  const organizationId = onboarding.organization.id;

  const [availability, connectedProviders] = await Promise.all([
    fetchProviderAvailability(projectClient.request, organizationId),
    getConnectedCustodyProviders(projectClient.request).catch(() => null),
  ]);

  // The shell only routes here after onboarding, so a missing setting means
  // the organization runs on SDP's default RPC, not "none".
  const activeRpcProvider = onboarding.setup?.rpcProvider ?? "default";

  const detail = resolveIntegrationDetail({
    provider,
    custody:
      connectedProviders === null
        ? null
        : resolveCustodyIntegrations({
            connectedProviders,
            enabledProviders: availability.enabledCustodyProviders,
          }),
    rpc: resolveRpcIntegrations({
      selectedProvider: activeRpcProvider,
      entries: availability.providers.rpc,
    }),
    ramps: resolveRampIntegrations(availability.providers.ramps),
    compliance: resolveComplianceIntegrations(availability.providers.compliance),
  });

  if (!detail) {
    notFound();
  }

  return (
    <IntegrationDetailView
      detail={detail}
      rpc={
        detail.family === "rpc"
          ? {
              activeProvider: activeRpcProvider,
              canManage: dashboardAccess.capabilities.canManageOrgSettings,
              isEnabledInDeployment:
                availability.providers.rpc[provider as OrganizationRpcProvider]?.enabled ?? false,
              organizationId,
              byokConnections: await getByokConnections(
                provider,
                dashboardAccess.capabilities.canManageOrgSettings
              ),
            }
          : undefined
      }
    />
  );
}
