import { auth } from "@clerk/nextjs/server";
import type {
  CustodyWalletByIdResponse,
  CustodyWalletTokenBalance,
  PaymentWalletPolicy,
} from "@sdp/types";
import { SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  formatCustodyProviderName,
  getCustodyProviderCategory,
  getCustodyProviderEntry,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletActionsMenu } from "@/app/dashboard/custody/wallet-actions-menu";
import {
  loadWalletActivity,
  type WalletActivityPayload,
} from "@/app/dashboard/custody/wallet-activity.data";
import { WalletActivitySection } from "@/app/dashboard/custody/wallet-activity-section";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { WalletCategoryBadge } from "@/app/dashboard/custody/wallet-category-badge";
import { formatPurpose, truncateMiddle } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { formatDisplayLabel } from "@/lib/utils";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  resolveTotalBalance,
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
}

async function getWalletDetail(
  request: SdpApiClient["request"],
  walletId: string
): Promise<CustodyWalletByIdResponse["wallet"]> {
  const response = await request(`/v1/wallets/${encodeURIComponent(walletId)}`);
  if (response.status === 404) {
    notFound();
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SDP API request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data?: CustodyWalletByIdResponse };
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

async function getOwnedTokenRoutes(
  request: SdpApiClient["request"]
): Promise<Map<string, { id: string; name: string | null }>> {
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
          (token): token is { id: string; mintAddress: string; name?: string | null } =>
            typeof token.id === "string" &&
            typeof token.mintAddress === "string" &&
            token.mintAddress.trim().length > 0
        )
        .map((token) => [token.mintAddress, { id: token.id, name: token.name ?? null }] as const)
    );
  } catch {
    return new Map();
  }
}

async function getWalletActivity(
  request: SdpApiClient["request"],
  walletId: string,
  t: Awaited<ReturnType<typeof getTranslations>>
): Promise<WalletActivityPayload> {
  const result = await loadWalletActivity(request, walletId, t);
  return (
    result.data ?? {
      activityRows: [],
      activityError: result.error ?? t("DashboardCustody.walletActivityUnavailable"),
      activityNotice: null,
    }
  );
}

export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
  const t = await getTranslations();
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const { walletId } = await params;
  const resolvedWalletId = decodeURIComponent(walletId);
  const apiClient = await createSdpApiClient();
  const [wallet, trackedBalancesResult, walletPolicyResult, ownedTokensByMint, walletActivity] =
    await Promise.all([
      getWalletDetail(apiClient.request, resolvedWalletId),
      getWalletTrackedBalances(
        apiClient.request,
        resolvedWalletId,
        t("DashboardCustody.trackedBalancesUnavailable")
      ),
      getWalletPolicy(
        apiClient.request,
        resolvedWalletId,
        t("DashboardCustody.walletControlsUnavailable")
      ),
      getOwnedTokenRoutes(apiClient.request),
      getWalletActivity(apiClient.request, resolvedWalletId, t),
    ]);

  const provider =
    wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
  const category = provider ? getCustodyProviderCategory(provider) : null;
  const supportsSignerCheck = provider
    ? getCustodyProviderEntry(provider).supportsSigning
    : !wallet.provider;
  const balances =
    trackedBalancesResult.balances.length > 0 ? trackedBalancesResult.balances : [wallet.balance];
  const totalBalance = resolveTotalBalance(balances);
  const purposeLabel = formatPurpose(wallet.purpose, t);

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
        <section className="overflow-hidden rounded-2xl border border-border-default bg-white">
          <div className="space-y-6 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                {provider ? <WalletProviderMark provider={provider} /> : null}
                <div className="space-y-2">
                  <h2 className="text-[36px] leading-[1.02] font-medium tracking-[-0.04em] text-primary">
                    {wallet.label?.trim() || t("DashboardCustody.untitledWallet")}
                  </h2>
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

        <section className="overflow-hidden rounded-2xl border border-border-default bg-white">
          <div className="space-y-6 p-6">
            <div>
              <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">
                {t("DashboardCustody.totalBalance")}
              </p>
              <p className="mt-3 text-[38px] leading-none font-medium tracking-[-0.05em] text-primary">
                {formatCurrencyAmount(totalBalance)}
              </p>
            </div>

            <div className="overflow-hidden rounded-2xl border border-border-subtle bg-fill-subtle">
              <WalletInfoRow
                label={t("DashboardCustody.address")}
                value={truncateMiddle(wallet.publicKey)}
                monospace
              />
              <WalletInfoRow
                label={t("DashboardCustody.provider")}
                value={
                  provider ? formatCustodyProviderName(provider) : t("DashboardCustody.unknown")
                }
              />
              {purposeLabel ? (
                <WalletInfoRow label={t("DashboardCustody.purpose")} value={purposeLabel} />
              ) : null}
            </div>
          </div>
        </section>
      </div>

      <WalletControlsPanel
        walletId={resolvedWalletId}
        policy={walletPolicyResult.policy}
        policyError={walletPolicyResult.error}
      />

      <section className="space-y-3">
        <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-primary">
          {t("DashboardCustody.balances")}
        </h3>
        {trackedBalancesResult.error ? (
          <p className="text-sm text-tertiary">{trackedBalancesResult.error}</p>
        ) : null}

        {balances.length > 0 ? (
          <div className="overflow-hidden rounded-2xl border border-border-default bg-white">
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
          <div className="rounded-2xl border border-border-default bg-white px-4 py-4 text-sm text-secondary">
            {t("DashboardCustody.noTrackedBalances")}
          </div>
        )}
      </section>

      <WalletActivitySection walletId={resolvedWalletId} initialActivity={walletActivity} />
    </DashboardWorkspaceOverviewPanel>
  );
}

function walletPolicyHasRestrictions(policy: PaymentWalletPolicy | null): boolean {
  if (!policy) return false;
  return (
    policy.destinationAllowlist.length > 0 ||
    Boolean(policy.maxTransferAmount) ||
    Boolean(policy.maxDailyAmount)
  );
}

async function WalletControlsPanel({
  walletId,
  policy,
  policyError,
}: {
  walletId: string;
  policy: PaymentWalletPolicy | null;
  policyError: string | null;
}) {
  const t = await getTranslations();
  const hasRestrictions = walletPolicyHasRestrictions(policy);
  const destinationCount = policy?.destinationAllowlist.length ?? 0;
  const policyHref = `/dashboard/wallets/${encodeURIComponent(walletId)}/policy`;

  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-white">
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
            <div className="grid gap-2 sm:grid-cols-3">
              <WalletControlMetric
                label={t("DashboardCustody.destinations")}
                value={destinationCount > 0 ? String(destinationCount) : t("DashboardCustody.open")}
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
      <div>
        <p className="text-[17px] font-medium text-primary">{label}</p>
        <p className="font-mono text-xs text-tertiary">{mint}</p>
      </div>
      <p className="text-[15px] text-primary">{value}</p>
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
