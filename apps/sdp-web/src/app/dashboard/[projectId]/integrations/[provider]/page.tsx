import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary, ProjectProviderAvailability, RampProviderId } from "@sdp/types";
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
import { custody, policies } from "@/flags";
import { getOfferedRampProviders } from "@/flags/ramps";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import {
  availableComplianceProviders,
  availableCustodyProviders,
  availableRampProviders,
  isProviderAvailableForProject,
  offersCustodyMode,
} from "@/lib/provider-availability";
import { fetchProjectProviderAvailability } from "@/lib/provider-availability.server";
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

async function getConnectedCustodyProviders(
  request: SdpApiClient["request"]
): Promise<KnownCustodyProvider[]> {
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
 * What the banner above the table asserts, or a summary that admits it knows
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
    return { signingPaused: false, complete: false };
  }
}

/**
 * The project's custody connections for this provider, plus their wallets.
 *
 * Returns `null` when the section does not apply (not a custody provider, or
 * the project's modes for it leave out `byok`) and `"restricted"` when the viewer may not read them — the
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
 * the Dashboard, which is what `self_service` means in the catalog, and only
 * while the project may set the provider up in `byok` mode. Gated on
 * `isKnownCustodyProvider` instead, this provider's connections list appeared
 * on every custody provider's page, and each row linked into the wrong
 * provider's detail route. `null` elsewhere, and the read is then skipped
 * entirely rather than fetched and discarded.
 *
 * @param provider - The provider id from the route.
 * @param custodyEnabled - Whether the custody module flag is on.
 * @param availability - The project's provider availability.
 * @returns The provider whose connections the page lists, or `null`.
 */
function resolveConnectionsProvider(
  provider: string,
  custodyEnabled: boolean,
  availability: ProjectProviderAvailability
): KnownCustodyProvider | null {
  if (!custodyEnabled || !isKnownCustodyProvider(provider)) {
    return null;
  }
  return offersCustodyMode(availability, provider, "byok") &&
    providerSupportsStoredCredentialSetup(provider)
    ? provider
    : null;
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
  };
}

/**
 * Resolves the provider on this page against the same family inputs the
 * catalog reads, so the detail header and the catalog card agree.
 *
 * @param params - The provider and the family inputs to resolve it against.
 * @param params.provider - The provider id from the route.
 * @param params.connectedProviders - Active custody providers.
 * @param params.availability - The project's provider availability.
 * @param params.rampProviders - The ramp providers offered (`getOfferedRampProviders`).
 * @returns The provider's detail, or `null` when no family lists it.
 */
function resolveDetail({
  provider,
  connectedProviders,
  availability,
  rampProviders,
}: {
  provider: string;
  connectedProviders: KnownCustodyProvider[];
  availability: ProjectProviderAvailability;
  rampProviders: readonly RampProviderId[];
}) {
  return resolveIntegrationDetail({
    provider,
    custody: resolveCustodyIntegrations({
      connectedProviders,
      custodyAvailability: availableCustodyProviders(availability),
    }),
    ramps: resolveRampIntegrations(availableRampProviders(availability), rampProviders),
    compliance: resolveComplianceIntegrations(availableComplianceProviders(availability)),
  });
}

/**
 * One provider's detail page, 404ing for unknown providers, for providers
 * whose module flag is off, and for providers the project cannot use.
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
  const [custodyEnabled, rampProviders, complianceEnabled] = await Promise.all([
    custody(),
    getOfferedRampProviders(),
    policies(),
  ]);
  if (
    !isIntegrationProviderEnabled(provider, {
      custody: custodyEnabled,
      rampProviders,
      compliance: complianceEnabled,
    })
  ) {
    notFound();
  }

  const { dashboardAccess, projectClient } = await resolveRequestContext();
  const resolvedSearchParams = (await searchParams) ?? {};

  const [availability, connectedProviders] = await Promise.all([
    fetchProjectProviderAvailability(projectClient),
    custodyEnabled ? getConnectedCustodyProviders(projectClient.request) : Promise.resolve([]),
  ]);
  if (!isProviderAvailableForProject(availability, provider)) {
    notFound();
  }

  const connectionsProvider = resolveConnectionsProvider(provider, custodyEnabled, availability);
  const connectionsRead = connectionsProvider
    ? await getCustodyConnections(
        projectClient.request,
        connectionsProvider,
        dashboardAccess.capabilities.canManageCustody,
        resolvedSearchParams
      )
    : null;

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
    rampProviders,
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
