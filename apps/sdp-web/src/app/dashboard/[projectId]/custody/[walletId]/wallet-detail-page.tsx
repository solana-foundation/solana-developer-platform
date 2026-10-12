import { auth } from "@clerk/nextjs/server";
import type { CustodyWalletMetadataResponse, CustodyWalletTokenBalance } from "@sdp/types";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import {
  ConnectionDetailRequestError,
  type CustodyInstallationConnection,
  fetchConnectionInstallation,
} from "@/app/dashboard/[projectId]/custody/connections/connection-detail.data";
import {
  formatCustodyProviderName,
  getCustodyProviderCategory,
  getCustodyProviderEntry,
} from "@/app/dashboard/[projectId]/custody/provider-catalog";
import { WalletActionsMenu } from "@/app/dashboard/[projectId]/custody/wallet-actions-menu";
import { WalletActivityViewport } from "@/app/dashboard/[projectId]/custody/wallet-activity-viewport";
import { WalletAddressCopyButton } from "@/app/dashboard/[projectId]/custody/wallet-address-copy-button";
import { WalletCategoryBadge } from "@/app/dashboard/[projectId]/custody/wallet-category-badge";
import {
  formatPurpose,
  truncateMiddle,
} from "@/app/dashboard/[projectId]/custody/wallet-format-utils";
import { WalletLabelInlineEditor } from "@/app/dashboard/[projectId]/custody/wallet-label-inline-editor";
import { WalletProviderMark } from "@/app/dashboard/[projectId]/custody/wallet-provider-mark";
import {
  WalletBalanceSummarySkeleton,
  WalletBalancesSkeleton,
} from "@/app/dashboard/[projectId]/wallets/wallet-route-skeletons";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { issuance } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { offersCustodyMode } from "@/lib/provider-availability";
import { fetchProjectProviderAvailability } from "@/lib/provider-availability.server";
import { createSdpApiClient, requestProjectHref, type SdpApiClient } from "@/lib/sdp-api";
import { getWalletMetadataPath } from "@/lib/sdp-api-paths";
import { formatDisplayLabel } from "@/lib/utils";
import {
  WalletBalanceRows,
  type WalletBalanceTokenRoutes,
  WalletBalanceTotal,
  type WalletTrackedBalancesResult,
} from "./wallet-detail-balances";

interface WalletBalancesResponse {
  walletBalances?: {
    walletId: string;
    address: string;
    balances: CustodyWalletTokenBalance[];
  };
}

interface OwnedTokenRoute {
  id: string;
  mintAddress: string | null;
  name?: string | null;
  symbol?: string | null;
}

/** Mint to issued-token detail, used for both deep links and naming assets. */
type OwnedTokensByMint = Map<string, { id: string; name: string | null; symbol: string | null }>;

async function getWalletDetail(
  request: SdpApiClient["request"],
  walletId: string
): Promise<CustodyWalletMetadataResponse["wallet"]> {
  const response = await request(getWalletMetadataPath(walletId));
  if (response.status === 404) {
    notFound();
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SDP API request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data?: CustodyWalletMetadataResponse };
  const wallet = json.data?.wallet;
  if (!wallet) {
    notFound();
  }

  return wallet;
}

/**
 * The connection row of a wallet created in a custody connection: the
 * connection's label, linked to its detail page, for a viewer who may manage
 * custody, and the truncated connection id, unlinked, for one who may not read
 * connections or whose lookup is refused (403) or finds no connection (404).
 * The label stays unlinked while the project does not offer the connection's
 * provider in `byok` mode, the same rule that hides the detail page. Any other
 * lookup failure throws.
 *
 * @param params - The wallet's connection and the viewer's access.
 * @param params.client - The client scoped to the request's project.
 * @param params.connectionId - The wallet's custody connection id, absent for a Managed wallet.
 * @param params.canManageCustody - Whether the viewer may read custody connections.
 * @returns The row's label and link, or `null` for a Managed wallet.
 */
async function resolveWalletConnectionRow(params: {
  client: SdpApiClient;
  connectionId: string | undefined;
  canManageCustody: boolean;
}): Promise<{ label: string; href: string | undefined } | null> {
  const { client, connectionId, canManageCustody } = params;
  if (connectionId === undefined) {
    return null;
  }
  if (!canManageCustody) {
    return { label: truncateMiddle(connectionId), href: undefined };
  }
  let connection: CustodyInstallationConnection;
  try {
    connection = await fetchConnectionInstallation(client.request, connectionId);
  } catch (error) {
    if (
      error instanceof ConnectionDetailRequestError &&
      (error.status === 403 || error.status === 404)
    ) {
      return { label: truncateMiddle(connectionId), href: undefined };
    }
    throw error;
  }
  if (
    !offersCustodyMode(await fetchProjectProviderAvailability(client), connection.provider, "byok")
  ) {
    return { label: connection.label, href: undefined };
  }
  return {
    label: connection.label,
    href: await requestProjectHref(
      `/dashboard/integrations/${connection.provider}/connections/${connectionId}`
    ),
  };
}

async function getWalletTrackedBalances(
  request: SdpApiClient["request"],
  walletId: string,
  unavailableMessage: string
): Promise<WalletTrackedBalancesResult> {
  const readAt = Date.now();
  try {
    const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/balances`);
    if (response.status === 404) {
      return { balances: [], error: null, readAt };
    }
    if (!response.ok) {
      return {
        balances: [],
        error: unavailableMessage,
        readAt,
      };
    }

    const json = (await response.json()) as { data?: WalletBalancesResponse };
    return { balances: json.data?.walletBalances?.balances ?? [], error: null, readAt };
  } catch {
    return {
      balances: [],
      error: unavailableMessage,
      readAt,
    };
  }
}

async function getOwnedTokenRoutes(request: SdpApiClient["request"]): Promise<OwnedTokensByMint> {
  try {
    const response = await request("/v1/issuance/tokens?page=1&pageSize=100");
    if (!response.ok) {
      return new Map();
    }

    const json = (await response.json()) as {
      data?: OwnedTokenRoute[];
    };

    return new Map(
      (json.data ?? [])
        .filter(
          (
            token
          ): token is {
            id: string;
            mintAddress: string;
            name?: string | null;
            symbol?: string | null;
          } =>
            typeof token.id === "string" &&
            typeof token.mintAddress === "string" &&
            token.mintAddress.trim().length > 0
        )
        .map(
          (token) =>
            [
              token.mintAddress,
              { id: token.id, name: token.name ?? null, symbol: token.symbol?.trim() || null },
            ] as const
        )
    );
  } catch {
    return new Map();
  }
}

export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
  const [t, { userId, orgId, orgRole }, { walletId }, issuanceEnabled] = await Promise.all([
    getTranslations(),
    auth(),
    params,
    issuance(),
  ]);
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const resolvedWalletId = decodeURIComponent(walletId);
  const apiClient = await createSdpApiClient();
  const walletPromise = getWalletDetail(apiClient.request, resolvedWalletId);
  const trackedBalancesPromise = getWalletTrackedBalances(
    apiClient.request,
    resolvedWalletId,
    t("DashboardCustody.trackedBalancesUnavailable")
  );
  const ownedTokensByMintPromise = getOwnedTokenRoutes(apiClient.request);
  const wallet = await walletPromise;

  const { provider } = wallet;
  const category = getCustodyProviderCategory(provider);
  const supportsSignerCheck = getCustodyProviderEntry(provider).supportsSigning;
  const purposeLabel = formatPurpose(wallet.purpose, t);
  const providerLabel = formatCustodyProviderName(provider);
  const canManageCustody = resolveDashboardAccess(orgRole).capabilities.canManageCustody;
  const connectionRow = await resolveWalletConnectionRow({
    client: apiClient,
    connectionId: wallet.custodyConnectionId,
    canManageCustody,
  });

  return (
    <DashboardWorkspaceOverviewPanel className="space-y-6">
      <div className="flex justify-end">
        <WalletActionsMenu
          walletAddress={wallet.publicKey}
          walletId={wallet.walletId}
          walletLabel={wallet.label}
          supportsSignerCheck={supportsSignerCheck}
          triggerMode="button"
          triggerLabel={t("DashboardCustody.actions")}
          triggerClassName="w-auto"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
          <div className="space-y-6 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <WalletProviderMark provider={provider} />
                <div className="space-y-2">
                  {/* biome-ignore lint/a11y/useSemanticElements: The inline editor can render a block-level input wrapper, which is invalid inside h2. */}
                  <div
                    role="heading"
                    aria-level={2}
                    aria-label={wallet.label?.trim() || t("DashboardCustody.untitledWallet")}
                    className="max-w-full text-[36px] leading-[1.02] font-medium tracking-[-0.04em] text-primary"
                  >
                    <WalletLabelInlineEditor
                      canEdit={canManageCustody}
                      emptyLabel={t("DashboardCustody.untitledWallet")}
                      label={wallet.label?.trim() || null}
                      walletId={wallet.walletId}
                    />
                  </div>
                  <p className="text-sm text-tertiary">{providerLabel}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {/* Restriction first: it is the one status a reader must not miss. */}
                {wallet.isRuntimeExecutionAllowed ? null : (
                  <Badge variant="warning">{t("DashboardCustody.restricted")}</Badge>
                )}
                <WalletCategoryBadge category={category} compact />
                {purposeLabel ? (
                  <span className="rounded-full bg-fill px-3 py-1.5 text-xs font-medium text-primary">
                    {purposeLabel}
                  </span>
                ) : null}
              </div>
            </div>

            {wallet.isRuntimeExecutionAllowed ? null : (
              <Callout variant="warning" title={t("DashboardCustody.signingDisabledTitle")}>
                {t("DashboardCustody.signingDisabledBody")}
              </Callout>
            )}

            <div className="overflow-hidden rounded-2xl border border-border-subtle bg-fill-subtle">
              <WalletInfoRow
                label={t("DashboardCustody.publicKey")}
                value={wallet.publicKey}
                monospace
                trailing={<WalletAddressCopyButton address={wallet.publicKey} />}
              />
              <WalletInfoRow
                label={t("DashboardCustody.walletId")}
                value={wallet.walletId}
                monospace
              />
              <WalletInfoRow
                label={t("DashboardCustody.status")}
                value={formatDisplayLabel(wallet.status)}
              />
              <WalletInfoRow label={t("DashboardCustody.provider")} value={providerLabel} />
              {connectionRow === null ? null : (
                <WalletInfoRow
                  label={t("DashboardCustody.connection")}
                  value={connectionRow.label}
                  href={connectionRow.href}
                />
              )}
              {purposeLabel ? (
                <WalletInfoRow label={t("DashboardCustody.purpose")} value={purposeLabel} />
              ) : null}
            </div>
          </div>
        </section>

        <Suspense fallback={<WalletBalanceSummarySkeleton />}>
          <WalletBalanceSummary
            walletId={resolvedWalletId}
            balancesPromise={trackedBalancesPromise}
            providerLabel={providerLabel}
            publicKey={wallet.publicKey}
            purposeLabel={purposeLabel}
            t={t}
          />
        </Suspense>
      </div>

      <Suspense fallback={<WalletBalancesSkeleton />}>
        <WalletBalancesSection
          walletId={resolvedWalletId}
          balancesPromise={trackedBalancesPromise}
          ownedTokensByMintPromise={ownedTokensByMintPromise}
          issuanceEnabled={issuanceEnabled}
          t={t}
        />
      </Suspense>

      <Suspense fallback={<WalletActivityViewport walletId={resolvedWalletId} />}>
        <WalletActivityWithBalanceSymbols
          walletId={resolvedWalletId}
          balancesPromise={trackedBalancesPromise}
          ownedTokensByMintPromise={ownedTokensByMintPromise}
        />
      </Suspense>
    </DashboardWorkspaceOverviewPanel>
  );
}

/**
 * Hands the activity table the symbols the balances lookup already resolved, plus the
 * ones this org issued, so a token the well-known catalogue has never seen still reads
 * as its symbol rather than a shortened mint. The fallback renders the same viewport
 * without the map, so activity is never gated on either lookup loading.
 */
async function WalletActivityWithBalanceSymbols({
  walletId,
  balancesPromise,
  ownedTokensByMintPromise,
}: {
  walletId: string;
  balancesPromise: Promise<WalletTrackedBalancesResult>;
  ownedTokensByMintPromise: Promise<OwnedTokensByMint>;
}) {
  const [{ balances }, ownedTokensByMint] = await Promise.all([
    balancesPromise,
    ownedTokensByMintPromise,
  ]);
  const symbolsByMint: Record<string, string> = {};
  // Seeded first so balances can override: a token this org issued should still be
  // named in activity even when the wallet holds none of it, which is exactly the
  // case for an asset it has only ever sent away.
  for (const [mint, token] of ownedTokensByMint) {
    if (token.symbol) {
      symbolsByMint[mint] = token.symbol;
    }
  }
  for (const balance of balances) {
    const mint = balance.mint?.trim();
    const token = balance.token?.trim();
    // Skip entries whose "symbol" is just the mint again — they carry no
    // information and would defeat the shortened-address fallback.
    if (mint && token && token !== mint) {
      symbolsByMint[mint] = token;
    }
  }

  return <WalletActivityViewport walletId={walletId} symbolsByMint={symbolsByMint} />;
}

export async function WalletBalanceSummary({
  walletId,
  balancesPromise,
  providerLabel,
  publicKey,
  purposeLabel,
  t,
}: {
  walletId: string;
  balancesPromise: Promise<WalletTrackedBalancesResult>;
  providerLabel: string;
  publicKey: string;
  purposeLabel: string | null;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const balancesResult = await balancesPromise;

  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="space-y-6 p-6">
        <div>
          <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">
            {t("DashboardCustody.totalBalance")}
          </p>
          <WalletBalanceTotal walletId={walletId} initial={balancesResult} />
        </div>

        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-fill-subtle">
          <WalletInfoRow
            label={t("DashboardCustody.address")}
            value={truncateMiddle(publicKey)}
            monospace
          />
          <WalletInfoRow label={t("DashboardCustody.provider")} value={providerLabel} />
          {purposeLabel ? (
            <WalletInfoRow label={t("DashboardCustody.purpose")} value={purposeLabel} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

export async function WalletBalancesSection({
  walletId,
  balancesPromise,
  ownedTokensByMintPromise,
  issuanceEnabled,
  t,
}: {
  walletId: string;
  balancesPromise: Promise<WalletTrackedBalancesResult>;
  ownedTokensByMintPromise: Promise<OwnedTokensByMint>;
  issuanceEnabled: boolean;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const [trackedBalancesResult, ownedTokensByMint] = await Promise.all([
    balancesPromise,
    ownedTokensByMintPromise,
  ]);
  const tokenRoutes: WalletBalanceTokenRoutes = {};
  for (const [mint, token] of ownedTokensByMint) {
    tokenRoutes[mint] = { id: token.id, name: token.name };
  }

  return (
    <section className="space-y-3">
      <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-primary">
        {t("DashboardCustody.balances")}
      </h3>
      <WalletBalanceRows
        walletId={walletId}
        initial={trackedBalancesResult}
        tokenRoutes={tokenRoutes}
        issuanceEnabled={issuanceEnabled}
        emptyLabel={t("DashboardCustody.noTrackedBalances")}
      />
    </section>
  );
}

function WalletInfoRow({
  label,
  value,
  monospace = false,
  trailing,
  href,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  trailing?: ReactNode;
  /** Renders the value as a link to the record it names. */
  href?: string;
}) {
  const valueClassName = [
    "truncate text-right text-[15px] text-primary",
    monospace ? "font-mono text-xs" : "",
  ].join(" ");

  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0">
      <p className="text-[15px] text-secondary">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        {href ? (
          <Link className={`${valueClassName} hover:underline`} href={href} title={value}>
            {value}
          </Link>
        ) : (
          <p className={valueClassName} title={value}>
            {value}
          </p>
        )}
        {trailing}
      </div>
    </div>
  );
}
