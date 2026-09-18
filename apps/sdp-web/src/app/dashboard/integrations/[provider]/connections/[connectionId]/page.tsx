import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import {
  ConnectionDetailRequestError,
  fetchConnectionInstallation,
  fetchConnectionListItem,
  fetchConnectionWallets,
  fetchCredentialLifecycle,
} from "@/app/dashboard/custody/connections/connection-detail.data";
import { ConnectionDetailView } from "@/app/dashboard/custody/connections/connection-detail-view";
import {
  isKnownCustodyProvider,
  providerSupportsStoredCredentialSetup,
} from "@/app/dashboard/custody/provider-catalog";
import { custody, privyByok } from "@/flags";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient } from "@/lib/sdp-api";

// The lifecycle view changes under other people — a rotation in a sibling
// project retires the credential this page is showing — so it is never served
// from a static render.
export const dynamic = "force-dynamic";

export default async function CustodyConnectionPage({
  params,
}: {
  params: Promise<{ provider: string; connectionId: string }>;
}) {
  const { provider, connectionId } = await params;
  // Same gate as the provider page's connections section: a provider with no
  // self-service credential install has no connections, so its `/connections/`
  // subtree is not a route at all.
  if (!isKnownCustodyProvider(provider) || !providerSupportsStoredCredentialSetup(provider)) {
    notFound();
  }

  const [custodyEnabled, byokEnabled] = await Promise.all([custody(), privyByok()]);
  if (!custodyEnabled || !byokEnabled) {
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
  // The internal custody routes are `custody:admin` for reads as well as
  // writes, so a member would get 403 on every request this page makes. Send
  // them back to the provider page, which tells them which role they need
  // rather than rendering a wall of failed reads.
  if (!dashboardAccess.capabilities.canManageCustody) {
    redirect(`/dashboard/integrations/${provider}`);
  }

  const client = await createSdpApiClient();

  let connection: Awaited<ReturnType<typeof fetchConnectionInstallation>>;
  try {
    connection = await fetchConnectionInstallation(client.request, connectionId);
  } catch (error) {
    if (error instanceof ConnectionDetailRequestError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  // The URL names a provider, the connection carries its own, and only the
  // second one is authoritative. Left unchecked, every action on this page
  // — rotate, roll back, make default — would be submitted under the URL's
  // provider and rejected by the API's consistency check, or worse, accepted
  // against the wrong account. Send the user to the connection's real home
  // rather than render it under a borrowed identity.
  if (connection.provider !== provider) {
    if (providerSupportsStoredCredentialSetup(connection.provider)) {
      redirect(
        `/dashboard/integrations/${connection.provider}/connections/${encodeURIComponent(connectionId)}`
      );
    }
    notFound();
  }

  // Wallets and credentials are read side by side, and each degrades on its
  // own: a credential read that fails does not cost the user the wallet list,
  // and vice versa.
  const [lifecycle, wallets, listItem] = await Promise.all([
    fetchCredentialLifecycle(client.request, connectionId),
    fetchConnectionWallets(client.request, connectionId).then(
      (rows) => ({ ok: true as const, rows }),
      () => ({ ok: false as const, rows: [] })
    ),
    // Safe to narrow by the URL's provider: the redirect above has already
    // established that it is the connection's own.
    fetchConnectionListItem(client.request, connectionId, provider),
  ]);

  return (
    <ConnectionDetailView
      connection={connection}
      listItem={listItem}
      lifecycle={lifecycle}
      wallets={wallets.rows}
      walletsUnavailable={!wallets.ok}
      provider={provider}
      canManageCustody={dashboardAccess.capabilities.canManageCustody}
    />
  );
}
