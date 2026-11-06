import { auth } from "@clerk/nextjs/server";
import type { ProjectProviderAvailability } from "@sdp/types/provider-access";
import { notFound, redirect } from "next/navigation";
import {
  fetchProjectIntegrations,
  findCustodyIntegration,
} from "@/app/(session)/dashboard/[projectId]/integrations/project-integrations.data";
import type { OnboardingStatusResponse } from "@/app/(session)/dashboard/[projectId]/onboarding-status";
import {
  buildConnectionsPageUrl,
  type ConnectionsProjectSummary,
  fetchConnectionsPage,
  fetchProviderConnections,
  fetchWalletsByConnection,
  parseConnectionsFilters,
  summarizeProviderConnections,
} from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections.data";
import {
  isKnownCustodyProvider,
  type KnownCustodyProvider,
  providerSupportsStoredCredentialSetup,
} from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { offersCustodyMode } from "@/lib/provider-availability";
import { fetchProjectProviderAvailability } from "@/lib/provider-availability.server";
import {
  createRequestScopedSdpApiClients,
  requestMemberRole,
  requestProjectHref,
  type SdpApiClient,
} from "@/lib/sdp-api";
import { type CustodyConnectionsContext, IntegrationDetailView } from "./integration-detail-view";

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
    return { signingPaused: false, signingCount: 0, complete: false };
  }
}

/**
 * The project's custody connections for this provider, plus their wallets.
 *
 * Returns `null` when the connections page read fails and `"restricted"` when
 * the viewer may not read them — the internal routes are `custody:admin` for reads as well as writes, so asking on
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
 * Connections exist only where a tenant installs its own credentials from the
 * Dashboard (`self_service` in the catalog), and only while the project may set
 * the provider up in `byok` mode. The integration state cannot say that for a
 * provider connected in `managed` mode, so this asks the availability read.
 */
function resolveConnectionsProvider(
  provider: KnownCustodyProvider,
  availability: ProjectProviderAvailability
): KnownCustodyProvider | null {
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
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  const dashboardAccess = resolveDashboardAccess(await requestMemberRole());

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
 * One custody provider's detail page. 404s for any provider the project's
 * integrations read does not list under custody, so the page never states
 * what the catalog row contradicts.
 */
export default async function IntegrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { provider } = await params;
  if (!isKnownCustodyProvider(provider)) {
    notFound();
  }

  const { dashboardAccess, projectClient } = await resolveRequestContext();
  const resolvedSearchParams = await searchParams;

  const [integrations, availability] = await Promise.all([
    fetchProjectIntegrations(projectClient),
    fetchProjectProviderAvailability(projectClient),
  ]);
  const integration = findCustodyIntegration(integrations, provider);
  if (!integration) {
    notFound();
  }

  const connectionsProvider = resolveConnectionsProvider(provider, availability);
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

  return (
    <IntegrationDetailView
      integration={integration}
      custodyConnections={connectionsRead?.context ?? null}
      canManageCustody={dashboardAccess.capabilities.canManageCustody}
    />
  );
}
