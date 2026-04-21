import { auth } from "@clerk/nextjs/server";
import type {
  CustodyWalletByIdResponse,
  CustodyWalletTokenBalance,
  PaymentTransferSummary,
} from "@sdp/types";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletActionsMenu } from "@/app/dashboard/custody/wallet-actions-menu";
import { WalletActivitySection } from "@/app/dashboard/custody/wallet-activity-section";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatPurpose, truncateMiddle } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  resolveTotalBalance,
} from "../../payments/payments-overview.utils";
import { fetchPaymentTransfers } from "../../payments/payments-page.data";

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
  walletId: string
): Promise<CustodyWalletTokenBalance[]> {
  const response = await request(`/v1/payments/wallets/${encodeURIComponent(walletId)}/balances`);
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SDP API request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data?: WalletBalancesResponse };
  return json.data?.walletBalances?.balances ?? [];
}

async function getOwnedTokenRoutes(request: SdpApiClient["request"]): Promise<Map<string, string>> {
  try {
    // biome-ignore lint/security/noSecrets: Public API path with pagination query parameters.
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
          (token): token is { id: string; mintAddress: string } =>
            typeof token.id === "string" &&
            typeof token.mintAddress === "string" &&
            token.mintAddress.trim().length > 0
        )
        .map((token) => [token.mintAddress, token.id] as const)
    );
  } catch {
    return new Map();
  }
}

async function getWalletTransfers(
  request: SdpApiClient["request"],
  walletId: string
): Promise<{
  transfers: PaymentTransferSummary[];
  error: string | null;
}> {
  const result = await fetchPaymentTransfers(request, 20, { walletId });
  return {
    transfers: result.data ?? [],
    error: result.ok ? null : (result.error ?? "Wallet activity is unavailable right now."),
  };
}

export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
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
  const [wallet, trackedBalances, ownedTokensByMint, walletTransfersResult] = await Promise.all([
    getWalletDetail(apiClient.request, resolvedWalletId),
    getWalletTrackedBalances(apiClient.request, resolvedWalletId),
    getOwnedTokenRoutes(apiClient.request),
    getWalletTransfers(apiClient.request, resolvedWalletId),
  ]);

  const provider =
    wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
  const balances = trackedBalances.length > 0 ? trackedBalances : [wallet.balance];
  const totalBalance = resolveTotalBalance(balances);
  const purposeLabel = formatPurpose(wallet.purpose);

  return (
    <div className="w-full space-y-6 py-2">
      <div className="flex justify-end">
        <WalletActionsMenu
          walletAddress={wallet.publicKey}
          walletId={wallet.walletId}
          walletLabel={wallet.label}
          triggerMode="button"
          triggerLabel="Actions"
          triggerClassName="w-auto"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <section className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
          <div className="space-y-6 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                {provider ? <WalletProviderMark provider={provider} /> : null}
                <div className="space-y-2">
                  <h2 className="text-[36px] leading-[1.02] font-medium tracking-[-0.04em] text-[#1c1c1d]">
                    {wallet.label?.trim() || "Untitled wallet"}
                  </h2>
                  <p className="text-sm text-[rgba(28,28,29,0.58)]">
                    {provider ? formatCustodyProviderName(provider) : "Wallet"}
                  </p>
                </div>
              </div>
              {purposeLabel ? (
                <span className="rounded-full bg-[rgba(28,28,29,0.08)] px-3 py-1.5 text-xs font-medium text-[#1c1c1d]">
                  {purposeLabel}
                </span>
              ) : null}
            </div>

            <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)]">
              <WalletInfoRow
                label="Public key"
                value={wallet.publicKey}
                monospace
                trailing={<WalletAddressCopyButton address={wallet.publicKey} />}
              />
              <WalletInfoRow label="Wallet ID" value={wallet.walletId} monospace />
              <WalletInfoRow label="Status" value={wallet.status} />
              {provider ? (
                <WalletInfoRow label="Provider" value={formatCustodyProviderName(provider)} />
              ) : null}
              {purposeLabel ? <WalletInfoRow label="Purpose" value={purposeLabel} /> : null}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
          <div className="space-y-6 p-6">
            <div>
              <p className="text-xs font-medium tracking-[0.14em] text-[rgba(28,28,29,0.48)] uppercase">
                Total balance
              </p>
              <p className="mt-3 text-[38px] leading-none font-medium tracking-[-0.05em] text-[#1c1c1d]">
                {formatCurrencyAmount(totalBalance)}
              </p>
            </div>

            <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)]">
              <WalletInfoRow label="Address" value={truncateMiddle(wallet.publicKey)} monospace />
              <WalletInfoRow
                label="Provider"
                value={provider ? formatCustodyProviderName(provider) : "Unknown"}
              />
              {purposeLabel ? <WalletInfoRow label="Purpose" value={purposeLabel} /> : null}
            </div>
          </div>
        </section>
      </div>

      <section className="space-y-3">
        <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">
          Balances
        </h3>

        {balances.length > 0 ? (
          <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
            {balances.map((balance) => {
              const ownedTokenId =
                balance.token === "SOL" ? null : (ownedTokensByMint.get(balance.mint) ?? null);

              return (
                <WalletBalanceRow
                  key={`${balance.mint}-${balance.token}`}
                  label={balance.token}
                  value={formatDisplayAmount(balance.uiAmount, balance.token)}
                  mint={balance.mint}
                  href={ownedTokenId ? `/dashboard/issuance/${ownedTokenId}` : null}
                />
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white px-4 py-4 text-sm text-[rgba(28,28,29,0.62)]">
            No tracked balances found yet for this wallet.
          </div>
        )}
      </section>

      <WalletActivitySection
        walletId={resolvedWalletId}
        initialTransfers={walletTransfersResult.transfers}
        initialTransfersError={walletTransfersResult.error}
      />
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
    <div className="flex items-center justify-between gap-4 border-b border-[rgba(28,28,29,0.08)] px-4 py-3 last:border-b-0">
      <p className="text-[15px] text-[rgba(28,28,29,0.68)]">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        <p
          className={[
            "truncate text-right text-[15px] text-[#1c1c1d]",
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
        "flex flex-wrap items-center justify-between gap-4 border-b border-[rgba(28,28,29,0.08)] px-4 py-3 last:border-b-0",
        href ? "transition-colors hover:bg-[rgba(28,28,29,0.03)]" : "",
      ].join(" ")}
    >
      <div>
        <p className="text-[17px] font-medium text-[#1c1c1d]">{label}</p>
        <p className="font-mono text-xs text-[rgba(28,28,29,0.52)]">{mint}</p>
      </div>
      <p className="text-[15px] text-[#1c1c1d]">{value}</p>
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
