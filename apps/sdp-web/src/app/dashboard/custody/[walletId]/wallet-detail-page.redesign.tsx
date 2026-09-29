import { auth } from "@clerk/nextjs/server";
import type { CustodyWalletMetadataResponse, PaymentWalletPolicy } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { fetchConnectionInstallation } from "@/app/dashboard/custody/connections/connection-detail.data";
import {
  formatCustodyProviderName,
  getCustodyProviderEntry,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import {
  formatWalletPurposeLabel,
  truncateMiddle,
} from "@/app/dashboard/custody/wallet-format-utils";
import { issuance, policies, privyByok } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";
import { getWalletMetadataPath } from "@/lib/sdp-api-paths";
import { fetchMemberNames, fetchRevisionHistory } from "./policy/policy-audit.data";
import type {
  IssuedTokensByMint,
  WalletBalancesResult,
  WalletPageView,
  WalletPolicyResult,
  WalletRevisionsResult,
} from "./wallet-detail.shared";
import { WalletDetailView } from "./wallet-detail-view";

interface WalletBalancesResponse {
  walletBalances?: {
    walletId: string;
    address: string;
    balances: WalletBalancesResult["balances"];
  };
}

interface OwnedTokenRoute {
  id: string;
  mintAddress: string | null;
  name?: string | null;
  symbol?: string | null;
}

export async function getWalletDetail(
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

export async function getWalletTrackedBalances(
  request: SdpApiClient["request"],
  walletId: string,
  unavailableMessage: string
): Promise<WalletBalancesResult> {
  try {
    const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/balances`);
    if (response.status === 404) {
      return { balances: [], error: null };
    }
    if (!response.ok) {
      return { balances: [], error: unavailableMessage };
    }

    const json = (await response.json()) as { data?: WalletBalancesResponse };
    return { balances: json.data?.walletBalances?.balances ?? [], error: null };
  } catch {
    return { balances: [], error: unavailableMessage };
  }
}

export async function getWalletPolicy(
  request: SdpApiClient["request"],
  walletId: string,
  unavailableMessage: string
): Promise<WalletPolicyResult> {
  try {
    const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/policies`);
    if (response.status === 404) {
      const empty: PaymentWalletPolicy = {
        walletId,
        defaultAction: "allow",
        rules: [],
        controlProfile: null,
      };
      return { policy: empty, error: null };
    }
    if (!response.ok) {
      return { policy: null, error: unavailableMessage };
    }

    const json = (await response.json()) as { data?: { policy?: PaymentWalletPolicy } };
    const policy = json.data?.policy;
    return policy ? { policy, error: null } : { policy: null, error: unavailableMessage };
  } catch {
    return { policy: null, error: unavailableMessage };
  }
}

async function getWalletRevisions(
  request: SdpApiClient["request"],
  walletId: string
): Promise<WalletRevisionsResult> {
  try {
    const [history, userNames] = await Promise.all([
      fetchRevisionHistory(request, walletId),
      fetchMemberNames(request),
    ]);
    return { history, userNames, error: null };
  } catch (error) {
    return { history: null, userNames: {}, error: readableApiError(error) };
  }
}

/** Tokens this organization issued, by mint; empty when the lookup fails. */
async function getIssuedTokens(request: SdpApiClient["request"]): Promise<IssuedTokensByMint> {
  try {
    const response = await request("/v1/issuance/tokens?page=1&pageSize=100");
    if (!response.ok) return {};
    const json = (await response.json()) as { data?: OwnedTokenRoute[] };
    const tokens: IssuedTokensByMint = {};
    for (const token of json.data ?? []) {
      if (typeof token.id !== "string" || !token.mintAddress?.trim()) continue;
      tokens[token.mintAddress] = {
        id: token.id,
        name: token.name ?? null,
        symbol: token.symbol?.trim() || null,
      };
    }
    return tokens;
  } catch {
    return {};
  }
}

/**
 * One wallet's page. The wallet itself is read before anything renders (its name heads the
 * page); balances, the policy and its revisions, and the issued-token names are handed to the
 * view as promises, so each part streams in on its own instead of holding the page.
 */
export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
  const [
    t,
    { userId, orgId, orgRole },
    { walletId },
    issuanceEnabled,
    policiesEnabled,
    byokEnabled,
  ] = await Promise.all([getTranslations(), auth(), params, issuance(), policies(), privyByok()]);
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const resolvedWalletId = decodeURIComponent(walletId);
  const apiClient = await createSdpApiClient();
  const walletPromise = getWalletDetail(apiClient.request, resolvedWalletId);
  const balancesPromise = getWalletTrackedBalances(
    apiClient.request,
    resolvedWalletId,
    t("DashboardCustody.trackedBalancesUnavailable")
  );
  const policyPromise = policiesEnabled
    ? getWalletPolicy(
        apiClient.request,
        resolvedWalletId,
        t("DashboardCustody.walletControlsUnavailable")
      )
    : null;
  const revisionsPromise = policiesEnabled
    ? getWalletRevisions(apiClient.request, resolvedWalletId)
    : null;
  const issuedTokensPromise = getIssuedTokens(apiClient.request);
  const wallet = await walletPromise;

  const provider =
    wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
  const canManageCustody = resolveDashboardAccess(orgRole).capabilities.canManageCustody;
  // The connection label is optional; keep the wallet and its connection id if the lookup fails.
  const connection =
    byokEnabled && canManageCustody && wallet.custodyConnectionId
      ? await fetchConnectionInstallation(apiClient.request, wallet.custodyConnectionId).catch(
          () => null
        )
      : null;

  const view: WalletPageView = {
    walletId: wallet.walletId,
    name: wallet.label?.trim() || t("DashboardCustody.untitledWallet"),
    label: wallet.label?.trim() || null,
    publicKey: wallet.publicKey,
    provider,
    providerName: provider
      ? formatCustodyProviderName(provider)
      : (wallet.provider ?? t("DashboardCustody.unknown")),
    purposeLabel: formatWalletPurposeLabel(wallet.purpose, t),
    createdAt: wallet.createdAt ?? null,
    isRuntimeExecutionAllowed: wallet.isRuntimeExecutionAllowed,
    supportsSignerCheck: provider
      ? getCustodyProviderEntry(provider).supportsSigning
      : !wallet.provider,
    connection: wallet.custodyConnectionId
      ? {
          label: connection?.label ?? truncateMiddle(wallet.custodyConnectionId),
          href:
            byokEnabled && canManageCustody
              ? `/dashboard/integrations/${connection?.provider ?? provider ?? "privy"}/connections/${wallet.custodyConnectionId}`
              : null,
        }
      : null,
    canManageCustody,
  };

  return (
    <WalletDetailView
      wallet={view}
      balancesPromise={balancesPromise}
      policyPromise={policyPromise}
      revisionsPromise={revisionsPromise}
      issuedTokensPromise={issuedTokensPromise}
      issuanceEnabled={issuanceEnabled}
    />
  );
}
