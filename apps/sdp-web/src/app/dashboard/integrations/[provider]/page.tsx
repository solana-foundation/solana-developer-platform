import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary, OrganizationRpcProvider } from "@sdp/types";
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
import {
  collectConnections,
  findProvidersWithOwnKey,
  findServingProvider,
} from "../rpc-serving-provider.server";
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
    // Both scopes: connections are made on the project now (HOO-1226), but the
    // organization-scoped ones made before that still exist and the relay
    // refuses to route while one is sitting there. Hiding them would leave the
    // tenant reading an error with nothing on screen to act on.
    const [projectScoped, organizationScoped] = await Promise.all([
      collectConnections(client, "project"),
      collectConnections(client, "organization"),
    ]);

    const all = [...projectScoped, ...organizationScoped];

    // Every live project connection, across all six providers. The list handed
    // to the section is narrowed to this provider, so counting inside it made
    // "the only connection routing this project" true on every page at once —
    // a Ready key sitting beside a serving one warned that deactivating it
    // would fall back to SDP's, when it routes nothing either way.
    const liveProjectConnections = all.filter(
      (connection) => connection.scope === "project" && connection.status !== "deactivated"
    ).length;

    return {
      connections: all.filter((connection) => connection.provider === provider),
      liveProjectConnections,
      servingProvider: findServingProvider(all),
      // A provider the project holds its own key for is usable whatever this
      // deployment carries, so the header must not call it Not configured.
      providersWithOwnKey: findProvidersWithOwnKey(all),
    };
  } catch {
    return null;
  }
}

/**
 * Flatten the loader's answer into the props the view takes. The sentinels
 * (`undefined` not an RPC provider, `"restricted"` not permitted, `null` the
 * read failed) name no serving provider, so they pass straight through.
 */
function resolveByokProps(result: Awaited<ReturnType<typeof getByokConnections>>) {
  if (result === undefined || result === null || result === "restricted") {
    return {
      byokConnections: result,
      liveProjectConnections: 0,
      servingProvider: null,
      providersWithOwnKey: [] as string[],
    };
  }
  return {
    byokConnections: result.connections,
    liveProjectConnections: result.liveProjectConnections,
    servingProvider: result.servingProvider,
    providersWithOwnKey: result.providersWithOwnKey,
  };
}

/**
 * Whose credentials the organization runs on. `null` when it could not be
 * read: the control is hidden rather than shown defaulted, because rendering
 * "SDP-managed" at an organization that is actually on its own keys is the
 * kind of wrong that gets acted on.
 */
async function getRpcCredentialMode(
  canManage: boolean
): Promise<{ mode: "managed" | "byok"; liveConnections: number } | null> {
  if (!canManage) {
    return null;
  }

  try {
    const client = await createSdpApiClient();
    return await client.fetch<{ mode: "managed" | "byok"; liveConnections: number }>(
      "/internal/dashboard/rpc/credential-mode"
    );
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

  const [availability, connectedProviders, credentialModeState, byokState] = await Promise.all([
    fetchProviderAvailability(projectClient.request, organizationId),
    getConnectedCustodyProviders(projectClient.request).catch(() => null),
    getRpcCredentialMode(dashboardAccess.capabilities.canManageOrgSettings),
    getByokConnections(provider, dashboardAccess.capabilities.canManageOrgSettings),
  ]);

  // The shell only routes here after onboarding, so a missing setting means
  // the organization runs on SDP's default RPC, not "none".
  const activeRpcProvider = onboarding.setup?.rpcProvider ?? "default";
  const byok = resolveByokProps(byokState);

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
      // The header badge answers the same question the panel under it does, so
      // it has to read the same source. It used to read the selection alone and
      // say Connected on a provider the project's traffic never touched.
      servingProvider: byok.servingProvider,
      providersWithOwnKey: byok.providersWithOwnKey,
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
              ...byok,
              credentialMode: credentialModeState?.mode ?? null,
              liveConnectionCount: credentialModeState?.liveConnections ?? 0,
            }
          : undefined
      }
    />
  );
}
