import { auth } from "@clerk/nextjs/server";
import type {
  CustodyWalletMetadataResponse,
  CustodyWalletTokenBalance,
  PaymentWalletPolicy,
  PolicyRuleAction,
} from "@sdp/types";
import { SlidersHorizontal } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import {
  formatCustodyProviderName,
  getCustodyProviderCategory,
  getCustodyProviderEntry,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletActionsMenu } from "@/app/dashboard/custody/wallet-actions-menu";
import { WalletActivityViewport } from "@/app/dashboard/custody/wallet-activity-viewport";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { WalletCategoryBadge } from "@/app/dashboard/custody/wallet-category-badge";
import { formatPurpose, truncateMiddle } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletLabelInlineEditor } from "@/app/dashboard/custody/wallet-label-inline-editor";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import {
  WalletBalanceSummarySkeleton,
  WalletBalancesSkeleton,
  WalletControlsSkeleton,
} from "@/app/dashboard/wallets/wallet-route-skeletons";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { getWalletMetadataPath } from "@/lib/sdp-api-paths";
import { formatDisplayLabel } from "@/lib/utils";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  resolveTotalBalance,
  resolveTransferTokenLabel,
  shortenAddress,
} from "../../payments/payments-overview.utils";

interface WalletBalancesResponse {
  walletBalances?: {
    walletId: string;
    address: string;
    balances: CustodyWalletTokenBalance[];
  };
}

interface WalletTrackedBalancesResult {
  balances: CustodyWalletTokenBalance[];
  error: string | null;
}

interface WalletPolicyResult {
  policy: PaymentWalletPolicy | null;
  error: string | null;
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

async function getWalletTrackedBalances(
  request: SdpApiClient["request"],
  walletId: string,
  unavailableMessage: string
): Promise<WalletTrackedBalancesResult> {
  try {
    const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/balances`);
    if (response.status === 404) {
      return { balances: [], error: null };
    }
    if (!response.ok) {
      return {
        balances: [],
        error: unavailableMessage,
      };
    }

    const json = (await response.json()) as { data?: WalletBalancesResponse };
    return { balances: json.data?.walletBalances?.balances ?? [], error: null };
  } catch {
    return {
      balances: [],
      error: unavailableMessage,
    };
  }
}

async function getWalletPolicy(
  request: SdpApiClient["request"],
  walletId: string,
  unavailableMessage: string
): Promise<WalletPolicyResult> {
  try {
    const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/policies`);
    if (response.status === 404) {
      return {
        policy: {
          walletId,
          destinationAllowlist: [],
        },
        error: null,
      };
    }
    if (!response.ok) {
      return {
        policy: null,
        error: unavailableMessage,
      };
    }

    const json = (await response.json()) as { data?: { policy?: PaymentWalletPolicy } };
    return {
      policy: json.data?.policy ?? {
        walletId,
        destinationAllowlist: [],
      },
      error: null,
    };
  } catch {
    return {
      policy: null,
      error: unavailableMessage,
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
  const [t, { userId, orgId, orgRole }, { walletId }] = await Promise.all([
    getTranslations(),
    auth(),
    params,
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
  const walletPolicyPromise = getWalletPolicy(
    apiClient.request,
    resolvedWalletId,
    t("DashboardCustody.walletControlsUnavailable")
  );
  const ownedTokensByMintPromise = getOwnedTokenRoutes(apiClient.request);
  const wallet = await walletPromise;

  const provider =
    wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
  const category = provider ? getCustodyProviderCategory(provider) : null;
  const supportsSignerCheck = provider
    ? getCustodyProviderEntry(provider).supportsSigning
    : !wallet.provider;
  const purposeLabel = formatPurpose(wallet.purpose, t);
  const providerLabel = provider
    ? formatCustodyProviderName(provider)
    : t("DashboardCustody.unknown");
  const canManageCustody = resolveDashboardAccess(orgRole).capabilities.canManageCustody;

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
                {provider ? <WalletProviderMark provider={provider} /> : null}
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
                  <p className="text-sm text-tertiary">
                    {provider ? formatCustodyProviderName(provider) : t("DashboardCustody.wallet")}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {category ? <WalletCategoryBadge category={category} compact /> : null}
                {purposeLabel ? (
                  <span className="rounded-full bg-fill px-3 py-1.5 text-xs font-medium text-primary">
                    {purposeLabel}
                  </span>
                ) : null}
              </div>
            </div>

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
              {provider ? (
                <WalletInfoRow
                  label={t("DashboardCustody.provider")}
                  value={formatCustodyProviderName(provider)}
                />
              ) : null}
              {purposeLabel ? (
                <WalletInfoRow label={t("DashboardCustody.purpose")} value={purposeLabel} />
              ) : null}
            </div>
          </div>
        </section>

        <Suspense fallback={<WalletBalanceSummarySkeleton />}>
          <WalletBalanceSummary
            balancesPromise={trackedBalancesPromise}
            providerLabel={providerLabel}
            publicKey={wallet.publicKey}
            purposeLabel={purposeLabel}
            t={t}
          />
        </Suspense>
      </div>

      <Suspense fallback={<WalletControlsSkeleton />}>
        <WalletControlsPanel
          walletId={resolvedWalletId}
          policyPromise={walletPolicyPromise}
          ownedTokensByMintPromise={ownedTokensByMintPromise}
          t={t}
        />
      </Suspense>

      <Suspense fallback={<WalletBalancesSkeleton />}>
        <WalletBalancesSection
          balancesPromise={trackedBalancesPromise}
          ownedTokensByMintPromise={ownedTokensByMintPromise}
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
  balancesPromise,
  providerLabel,
  publicKey,
  purposeLabel,
  t,
}: {
  balancesPromise: Promise<WalletTrackedBalancesResult>;
  providerLabel: string;
  publicKey: string;
  purposeLabel: string | null;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const balancesResult = await balancesPromise;
  const totalBalance = balancesResult.error ? null : resolveTotalBalance(balancesResult.balances);

  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="space-y-6 p-6">
        <div>
          <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">
            {t("DashboardCustody.totalBalance")}
          </p>
          {balancesResult.error ? (
            <div className="mt-3 space-y-2">
              <p className="text-[38px] leading-none font-medium tracking-[-0.05em] text-primary">
                —
              </p>
              <p className="text-sm text-tertiary">{balancesResult.error}</p>
            </div>
          ) : (
            <p className="mt-3 text-[38px] leading-none font-medium tracking-[-0.05em] text-primary">
              {formatCurrencyAmount(totalBalance)}
            </p>
          )}
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
  balancesPromise,
  ownedTokensByMintPromise,
  t,
}: {
  balancesPromise: Promise<WalletTrackedBalancesResult>;
  ownedTokensByMintPromise: Promise<OwnedTokensByMint>;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const [trackedBalancesResult, ownedTokensByMint] = await Promise.all([
    balancesPromise,
    ownedTokensByMintPromise,
  ]);
  const balances = trackedBalancesResult.balances;

  return (
    <section className="space-y-3">
      <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-primary">
        {t("DashboardCustody.balances")}
      </h3>
      {trackedBalancesResult.error ? (
        <p className="text-sm text-tertiary">{trackedBalancesResult.error}</p>
      ) : null}

      {balances.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
          {balances.map((balance) => {
            const ownedToken =
              balance.token === "SOL" ? null : (ownedTokensByMint.get(balance.mint) ?? null);

            return (
              <WalletBalanceRow
                key={`${balance.mint}-${balance.token}`}
                label={ownedToken?.name ?? balance.token}
                value={formatDisplayAmount(balance.uiAmount, balance.token)}
                mint={balance.mint}
                href={ownedToken ? `/dashboard/issuance/${ownedToken.id}` : null}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-border-default bg-surface-raised px-4 py-4 text-sm text-secondary">
          {t("DashboardCustody.noTrackedBalances")}
        </div>
      )}
    </section>
  );
}

/**
 * Distinct mints named by the profile's asset rules. The rules array is the
 * source of truth for allowed assets; destinationAllowlist and the amount caps
 * are stored separately and say nothing about which tokens are permitted.
 */
/**
 * Mints named by an allow-action asset rule — the only rules that express an
 * allowlist, and so the only ones honest to render under "Allowed assets".
 *
 * An asset rule can equally carry `deny` or `approval_required`, and listing
 * those mints as allowed would state the opposite of what the profile
 * enforces — the worst kind of wrong on a custody screen.
 *
 * Other kinds are excluded because they say something different: `amount`
 * rules only cap the mints they name, leaving other assets transferable, and
 * `approval` rules gate rather than permit. A profile restricted solely by one
 * of those still reads as restricted — see policyRuleRestricts, which
 * classifies rules independently of this list.
 */
function walletPolicyAssets(policy: PaymentWalletPolicy | null): string[] {
  const mints = new Set<string>();

  for (const rule of policy?.rules ?? []) {
    if (rule.kind !== "asset") continue;
    if (rule.action && rule.action !== "allow") continue;

    for (const mint of rule.assets ?? (rule.asset ? [rule.asset] : [])) {
      mints.add(mint);
    }
  }

  return [...mints];
}

/**
 * Whether a rule can produce anything other than `allow`.
 *
 * This mirrors evaluatePolicyRule in the API's policy-evaluation service. Two
 * details there drive the shape below:
 *
 * 1. An explicit `action` is authoritative for every kind — the evaluator
 *    applies it verbatim and only falls back to a per-kind default when the
 *    action is absent. So an `approval` rule pinned to `allow` permits, and a
 *    `review` or `provider_approval_required` action restricts on any kind.
 * 2. A rule with no criteria is not inert. `asset` with no assets, `amount`
 *    with no bounds and `destination` with neither list all resolve to
 *    `review`, which is a restriction rather than a no-op.
 */
const RESTRICTIVE_RULE_ACTIONS = new Set<PolicyRuleAction>([
  "deny",
  "approval_required",
  "provider_approval_required",
  "review",
]);

function policyRuleRestricts(rule: NonNullable<PaymentWalletPolicy["rules"]>[number]): boolean {
  if (rule.action) {
    return RESTRICTIVE_RULE_ACTIONS.has(rule.action);
  }

  switch (rule.kind) {
    case "approval":
      // Defaults to approval_required rather than allow.
      return true;
    case "amount":
      // Denies outside its bounds, and reviews when it has none.
      return true;
    case "destination":
      // Denies on a blocklist hit or outside an allowlist, reviews when empty.
      return true;
    case "asset":
      // Allows on a match and abstains otherwise, so it only restricts when it
      // names nothing and falls through to review.
      return !(rule.assets?.length || rule.asset);
    default:
      // always / operation_family / operation_type permit on a match.
      return false;
  }
}

function walletPolicyHasRestrictions(policy: PaymentWalletPolicy | null): boolean {
  if (!policy) return false;
  return (
    policy.destinationAllowlist.length > 0 ||
    Boolean(policy.maxTransferAmount) ||
    Boolean(policy.maxDailyAmount) ||
    // Operations matching no rule fall through to the policy default, so a
    // non-allow default is itself a restriction.
    (policy.defaultAction !== undefined && policy.defaultAction !== "allow") ||
    (policy.rules ?? []).some(policyRuleRestricts)
  );
}

async function WalletControlsPanel({
  walletId,
  policyPromise,
  ownedTokensByMintPromise,
  t,
}: {
  walletId: string;
  policyPromise: Promise<WalletPolicyResult>;
  ownedTokensByMintPromise: Promise<OwnedTokensByMint>;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const [{ policy, error: policyError }, ownedTokensByMint] = await Promise.all([
    policyPromise,
    ownedTokensByMintPromise,
  ]);
  const hasRestrictions = walletPolicyHasRestrictions(policy);
  const destinationCount = policy?.destinationAllowlist.length ?? 0;
  const allowedAssets = walletPolicyAssets(policy);
  // Names assets this org issued. Without it any mint outside the well-known
  // catalogue renders as a shortened address.
  const issuedSymbolsByMint: Record<string, string> = {};
  for (const [mint, token] of ownedTokensByMint) {
    if (token.symbol) issuedSymbolsByMint[mint] = token.symbol;
  }
  const policyHref = `/dashboard/wallets/${encodeURIComponent(walletId)}/policy`;

  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-2xl font-medium text-primary">
              {t("DashboardCustody.walletControls")}
            </h3>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-secondary">
            {hasRestrictions
              ? t("DashboardCustody.walletRestrictionsActive")
              : t("DashboardCustody.walletDefaultAllow")}
          </p>
          {policyError ? (
            <p className="text-sm text-error">{policyError}</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <WalletControlMetric
                  label={t("DashboardCustody.policyAllowedAssets")}
                  value={
                    allowedAssets.length > 0
                      ? String(allowedAssets.length)
                      : t("DashboardCustody.open")
                  }
                />
                <WalletControlMetric
                  label={t("DashboardCustody.destinations")}
                  value={
                    destinationCount > 0 ? String(destinationCount) : t("DashboardCustody.open")
                  }
                />
                <WalletControlMetric
                  label={t("DashboardCustody.perTransfer")}
                  value={policy?.maxTransferAmount ?? t("DashboardCustody.noCap")}
                />
                <WalletControlMetric
                  label={t("DashboardCustody.daily")}
                  value={policy?.maxDailyAmount ?? t("DashboardCustody.noCap")}
                />
              </div>
              {/* Named here rather than under Balances: these are the assets the
                  wallet may move, which is not the same as what it holds. */}
              {allowedAssets.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {allowedAssets.map((mint) => (
                    <li
                      key={mint}
                      className="flex items-center gap-2 rounded-full border border-border-subtle bg-fill-subtle py-1 pr-3 pl-1"
                      title={mint}
                    >
                      {/* Only issued symbols are handed over: TokenMark already
                          resolves well-known mints itself, and an unresolvable mint
                          should keep its neutral placeholder rather than take a
                          monogram cut from an address. */}
                      <TokenMark mint={mint} symbol={issuedSymbolsByMint[mint]} size="sm" />
                      <span className="text-xs font-medium text-secondary">
                        {resolveTransferTokenLabel(mint, issuedSymbolsByMint)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>
        <Button
          asChild
          variant={hasRestrictions ? "secondary" : "default"}
          className="w-full shrink-0 sm:w-auto"
        >
          <Link href={policyHref}>
            <SlidersHorizontal className="size-4" />
            {hasRestrictions
              ? t("DashboardCustody.reviewControls")
              : t("DashboardCustody.startProfile")}
          </Link>
        </Button>
      </div>
    </section>
  );
}

function WalletControlMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border-subtle bg-fill-subtle px-3 py-2">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-primary" title={value}>
        {value}
      </p>
    </div>
  );
}

function WalletInfoRow({
  label,
  value,
  monospace = false,
  trailing,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0">
      <p className="text-[15px] text-secondary">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        <p
          className={[
            "truncate text-right text-[15px] text-primary",
            monospace ? "font-mono text-xs" : "",
          ].join(" ")}
          title={value}
        >
          {value}
        </p>
        {trailing}
      </div>
    </div>
  );
}

function WalletBalanceRow({
  label,
  value,
  mint,
  href = null,
}: {
  label: string;
  value: string;
  mint: string;
  href?: string | null;
}) {
  const content = (
    <div
      className={[
        "flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0",
        href ? "transition-colors hover:bg-fill-subtle" : "",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-3">
        <TokenMark mint={mint} symbol={label} size="md" />
        <div className="min-w-0">
          <p className="text-[17px] font-medium text-primary">{label}</p>
          {/* The full mint is 44 characters; keep it reachable on hover rather
              than letting it dominate the row. */}
          <p className="font-mono text-xs text-tertiary" title={mint}>
            {shortenAddress(mint)}
          </p>
        </div>
      </div>
      <p className="text-[15px] text-primary tabular-nums">{value}</p>
    </div>
  );

  if (!href) {
    return content;
  }

  return (
    <Link href={href} className="block focus-visible:outline-none">
      {content}
    </Link>
  );
}
