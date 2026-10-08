import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import {
  buildConnectionsPageUrl,
  type ConnectionsProjectSummary,
  fetchConnectionsPage,
  fetchProviderConnections,
  fetchWalletsByConnection,
  parseConnectionsFilters,
  summarizeProviderConnections,
} from "@/app/dashboard/[projectId]/custody/connections/connections.data";
import {
  isKnownCustodyProvider,
  type KnownCustodyProvider,
  providerSupportsStoredCredentialSetup,
} from "@/app/dashboard/[projectId]/custody/provider-catalog";
import type { OnboardingStatusResponse } from "@/app/dashboard/[projectId]/onboarding-status";
import { custody, policies, privyByok } from "@/flags";
import { isRampsEnabled } from "@/flags/ramps";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import {
  createRequestScopedSdpApiClients,
  requestProjectHref,
  type SdpApiClient,
} from "@/lib/sdp-api";
import { isKnownIntegrationProvider, resolveIntegrationDetail } from "../integration-detail";
import { isIntegrationProviderEnabled } from "../integration-feature-gates";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
} from "../integrations-status";
import { type CustodyConnectionsContext, IntegrationDetailView } from "./integration-detail-view";

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
 * What the banners above the table assert, or a summary that admits it knows
 * nothing. Degraded on its own because it costs several requests where the
 * table costs one, and a hiccup on the third of them is no reason to blank a
 * table that loaded: `complete: false` is already the signal every caller reads
 * to stay quiet rather than state something it could not check.
 */
async function getCustodyConnectionsSummary(
  request: SdpApiClient["request"],
  provider: KnownCustodyProvider
): Promise<ConnectionsProjectSummary> {
  try {
    return summarizeProviderConnections(await fetchProviderConnections(request, provider));
  } catch {
    return { activeCount: 0, defaultConnection: null, signingPaused: false, complete: false };
  }
}

/**
 * The project's custody connections for this provider, plus their wallets.
 *
 * Returns `null` when the section does not apply (not a custody provider, or
 * BYOK is off) and `"restricted"` when the viewer may not read them — the
 * internal routes are `custody:admin` for reads as well as writes, so asking on
 * a member's behalf returns 403 every time. Not permitted is its own answer,
 * not a failed request.
 *
 * Only the page read is load-bearing. The wallet read and the project summary
 * each degrade on their own: a connection list without wallet columns, or
 * without the banners above it, is still worth rendering, and both say so.
 *
 * `out_of_range` is not a context to render but an address to send the user to,
 * so it is kept distinct from one — the caller redirects on it.
 */
async function getCustodyConnections(
  request: SdpApiClient["request"],
  provider: KnownCustodyProvider,
  canManage: boolean,
  searchParams: Record<string, string | string[] | undefined>
): Promise<
  { kind: "context"; context: CustodyConnectionsContext } | { kind: "out_of_range"; page: number }
> {
  if (!canManage) {
    return { kind: "context", context: "restricted" };
  }
  try {
    const [page, summary, wallets] = await Promise.all([
      fetchConnectionsPage(request, provider, parseConnectionsFilters(searchParams)),
      getCustodyConnectionsSummary(request, provider),
      fetchWalletsByConnection(request).then(
        (byConnection) => ({ ok: true as const, byConnection }),
        () => ({ ok: false as const })
      ),
    ]);
    if (page.status === "out_of_range") {
      return { kind: "out_of_range", page: page.page };
    }
    return {
      kind: "context",
      context: {
        result: page.result,
        filters: page.filters,
        summary,
        walletsByConnection: wallets.ok ? Object.fromEntries(wallets.byConnection) : {},
        walletsUnavailable: !wallets.ok,
      },
    };
  } catch {
    return { kind: "context", context: null };
  }
}

/**
 * Which provider's connections this page owns, if any.
 *
 * Connections exist only where a tenant can install its own credentials from
 * the Dashboard, which is what `self_service` means in the catalog. Gated on
 * `isKnownCustodyProvider` instead, this provider's connections list appeared
 * on every custody provider's page, and each row linked into the wrong
 * provider's detail route. `null` elsewhere, and the read is then skipped
 * entirely rather than fetched and discarded.
 */
function resolveConnectionsProvider(
  provider: string,
  custodyEnabled: boolean
): KnownCustodyProvider | null {
  if (!custodyEnabled || !isKnownCustodyProvider(provider)) {
    return null;
  }
  return providerSupportsStoredCredentialSetup(provider) ? provider : null;
}

/**
 * Who is asking, and which workspace this render is scoped to. Never returns
 * for a viewer who is signed out, has no organization, or is not onboarded.
 *
 * One gate rather than two, and strictly in this order. `auth()` is a local
 * session read with no round trip to overlap, so splitting it out to run
 * alongside the onboarding fetch buys nothing measurable and costs a request
 * sent on behalf of someone who is about to be redirected away.
 */
async function resolveRequestContext() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }
  const dashboardAccess = resolveDashboardAccess(orgRole);

  const { organizationClient, projectClient } = await createRequestScopedSdpApiClients({});
  const onboarding =
    await organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
  if (!onboarding.linked || !onboarding.organization) {
    redirect("/dashboard");
  }

  return {
    dashboardAccess,
    projectClient,
    organizationId: onboarding.organization.id,
  };
}

type ProviderAvailability = Awaited<ReturnType<typeof fetchProviderAvailability>>;

/**
 * Resolves the provider on this page against the same family inputs the
 * catalog reads, so the detail header and the catalog card agree.
 *
 * @param params - The provider and the family inputs to resolve it against.
 * @param params.provider - The provider id from the route.
 * @param params.connectedProviders - Active custody providers, or `null` when the lookup failed.
 * @param params.availability - The organization's provider availability.
 * @returns The provider's detail, or `null` when no family lists it.
 */
function resolveDetail({
  provider,
  connectedProviders,
  availability,
}: {
  provider: string;
  connectedProviders: KnownCustodyProvider[] | null;
  availability: ProviderAvailability;
}) {
  return resolveIntegrationDetail({
    provider,
    custody:
      connectedProviders === null
        ? null
        : resolveCustodyIntegrations({
            connectedProviders,
            enabledProviders: availability.enabledCustodyProviders,
          }),
    ramps: resolveRampIntegrations(availability.providers.ramps),
    compliance: resolveComplianceIntegrations(availability.providers.compliance),
  });
}

/**
 * One provider's detail page, 404ing for unknown providers and for providers
 * whose module flag is off.
 *
 * @param props - The route props.
 * @param props.params - The route params carrying the provider id.
 * @param props.searchParams - The query, read by the custody connections table.
 * @returns The rendered detail view.
 */
export default async function IntegrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  // Optional so the page stays callable without it: only the connections
  // table's `?page=` reads it, and every other caller — the feature-gate tests
  // included — has no query to pass.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { provider } = await params;
  if (!isKnownIntegrationProvider(provider)) {
    notFound();
  }
  const [custodyEnabled, rampsEnabled, complianceEnabled] = await Promise.all([
    custody(),
    isRampsEnabled(),
    policies(),
  ]);
  if (
    !isIntegrationProviderEnabled(provider, {
      custody: custodyEnabled,
      ramps: rampsEnabled,
      compliance: complianceEnabled,
    })
  ) {
    notFound();
  }

  const { dashboardAccess, projectClient, organizationId } = await resolveRequestContext();

  const connectionsProvider = resolveConnectionsProvider(provider, custodyEnabled);
  const custodyConnectionsApply = connectionsProvider !== null && (await privyByok());
  const resolvedSearchParams = (await searchParams) ?? {};

  const [availability, connectedProviders, connectionsRead] = await Promise.all([
    fetchProviderAvailability(projectClient.request, organizationId),
    custodyEnabled
      ? getConnectedCustodyProviders(projectClient.request).catch(() => null)
      : Promise.resolve([]),
    custodyConnectionsApply && connectionsProvider
      ? getCustodyConnections(
          projectClient.request,
          connectionsProvider,
          dashboardAccess.capabilities.canManageCustody,
          resolvedSearchParams
        )
      : Promise.resolve(null),
  ]);

  // A `?page=` past the end is answered with the address that page lives at,
  // not with its rows under the stale URL: served in place, the footer read
  // page 2 while the address bar still said page 9, and every reload or share
  // of that link paid for the out-of-range read and the correction again.
  if (connectionsRead?.kind === "out_of_range") {
    redirect(
      buildConnectionsPageUrl(
        await requestProjectHref(`/dashboard/integrations/${provider}`),
        resolvedSearchParams,
        connectionsRead.page
      )
    );
  }

  const detail = resolveDetail({
    provider,
    connectedProviders,
    availability,
  });

  if (!detail) {
    notFound();
  }

  return (
    <IntegrationDetailView
      detail={detail}
      custodyConnections={connectionsRead?.context ?? null}
      canManageCustody={dashboardAccess.capabilities.canManageCustody}
    />
  );
}
