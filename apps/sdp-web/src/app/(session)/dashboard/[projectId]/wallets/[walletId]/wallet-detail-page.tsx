import { auth } from "@clerk/nextjs/server";
import type { CustodyWalletMetadataResponse } from "@sdp/types/custody";
import { notFound, redirect } from "next/navigation";
import {
  formatCustodyProviderName,
  getCustodyProviderEntry,
  isKnownCustodyProvider,
} from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { formatWalletPurposeLabel } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-format-utils";
import { issuance } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, requestMemberRole, type SdpApiClient } from "@/lib/sdp-api";
import { getWalletMetadataPath } from "@/lib/sdp-api-paths";
import { resolveWalletConnectionRow } from "./wallet-connection-row";
import type { WalletPageView } from "./wallet-detail.shared";
import { WalletDetailView } from "./wallet-detail-view";

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

type Translate = Awaited<ReturnType<typeof getTranslations>>;
type WalletConnectionRow = Awaited<ReturnType<typeof resolveWalletConnectionRow>>;
/** What the page shows about the wallet itself, from its record and its connection's. */
function toWalletPageView(
  wallet: CustodyWalletMetadataResponse["wallet"],
  connection: WalletConnectionRow,
  canManageCustody: boolean,
  t: Translate
): WalletPageView {
  const provider =
    wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
  const label = wallet.label?.trim() || null;
  return {
    walletId: wallet.walletId,
    custodyWalletId: wallet.id,
    name: label ?? t("DashboardCustody.untitledWallet"),
    label,
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
    connection:
      connection === null ? null : { label: connection.label, href: connection.href ?? null },
    canManageCustody,
  };
}

/**
 * One wallet's page. The wallet itself is read before anything renders (its name heads the
 * page); its balances, activity and the issued-token names are read in the browser.
 */
export async function WalletDetailPage({ params }: { params: Promise<{ walletId: string }> }) {
  const [t, { orgId }, { walletId }, issuanceEnabled] = await Promise.all([
    getTranslations(),
    auth(),
    params,
    issuance(),
  ]);
  if (!orgId) {
    redirect("/dashboard");
  }

  const resolvedWalletId = decodeURIComponent(walletId);
  const apiClient = await createSdpApiClient();
  const wallet = await getWalletDetail(apiClient.request, resolvedWalletId);

  const canManageCustody = resolveDashboardAccess(await requestMemberRole()).capabilities
    .canManageCustody;
  const connection = await resolveWalletConnectionRow({
    client: apiClient,
    connectionId: wallet.custodyConnectionId,
    canManageCustody,
  });
  const view = toWalletPageView(wallet, connection, canManageCustody, t);

  return <WalletDetailView wallet={view} issuanceEnabled={issuanceEnabled} />;
}
