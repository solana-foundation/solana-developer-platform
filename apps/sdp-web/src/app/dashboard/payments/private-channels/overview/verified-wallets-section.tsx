"use client";

import type { CustodyWalletSummary, PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { CheckCircle2Icon, Loader2Icon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import type { WalletChannelBalance } from "../private-channels-page.data";
import { deleteVerifiedWalletAction, verifyWalletAction } from "./actions";

interface Props {
  verifiedWallets: PrivateChannelVerifiedWalletDto[];
  custodyWallets: CustodyWalletSummary[];
  /** Keyed by wallet pubkey; entry present when the balance read succeeded. */
  channelBalances: Record<string, WalletChannelBalance>;
  loadError: boolean;
}

function shortKey(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

/** Renders nothing when the gateway read for this wallet failed. */
function ChannelBalance({
  balance,
  t,
}: {
  balance: WalletChannelBalance | undefined;
  t: ReturnType<typeof useTranslations>;
}) {
  if (!balance) return null;
  // Named from the mint the API actually reported rather than a hardcoded symbol,
  // so the row stays truthful when the instance's allowed token is not USDC. Falls
  // back to a shortened mint for anything outside the catalogue.
  const known = WELL_KNOWN_TOKEN_BY_MINT.get(balance.mint);
  const symbol = known?.symbol ?? shortKey(balance.mint);
  return (
    <span
      className="font-mono text-sm text-secondary"
      title={t("DashboardPrivateChannels.verifiedWallets.channelBalanceTooltip", {
        mint: balance.mint,
      })}
    >
      {t("DashboardPrivateChannels.verifiedWallets.channelBalanceAmount", {
        amount: balance.uiAmount,
        symbol,
      })}
    </span>
  );
}

export function VerifiedWalletsSection({
  verifiedWallets,
  custodyWallets,
  channelBalances,
  loadError,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const t = useTranslations();

  const verifiedByPubkey = new Map(verifiedWallets.map((w) => [w.pubkey, w]));
  const custodyPubkeys = new Set(custodyWallets.map((w) => w.publicKey));
  // Keep delete reachable for verifications whose custody wallet is no longer listed.
  const orphanedVerified = verifiedWallets.filter((w) => !custodyPubkeys.has(w.pubkey));

  function handleVerify(walletId: string, pubkey: string) {
    setPendingKey(walletId);
    startTransition(async () => {
      const result = await verifyWalletAction(walletId);
      if (result.ok) {
        toast.success(
          t("DashboardPrivateChannels.verifiedWallets.verifySuccess", { key: shortKey(pubkey) })
        );
      } else {
        toast.error(result.message);
      }
      setPendingKey(null);
    });
  }

  function handleDelete(pubkey: string) {
    setPendingKey(pubkey);
    startTransition(async () => {
      const result = await deleteVerifiedWalletAction(pubkey);
      if (result.ok) {
        toast.success(
          t("DashboardPrivateChannels.verifiedWallets.revokeSuccess", { key: shortKey(pubkey) })
        );
      } else {
        toast.error(result.message);
      }
      setPendingKey(null);
    });
  }

  if (loadError) {
    return (
      <p className="text-sm text-status-error-text">
        {t("DashboardPrivateChannels.verifiedWallets.loadError")}
      </p>
    );
  }

  if (custodyWallets.length === 0 && orphanedVerified.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-secondary">
          {t("DashboardPrivateChannels.verifiedWallets.noWallets")}
        </p>
        <Button asChild>
          <Link href="/dashboard/wallets">
            {t("DashboardPrivateChannels.verifiedWallets.createWallet")}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
      {custodyWallets.map((wallet) => {
        const verified = verifiedByPubkey.get(wallet.publicKey);
        return (
          <li key={wallet.walletId} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              {wallet.provider && isKnownCustodyProvider(wallet.provider) ? (
                <WalletProviderMark provider={wallet.provider} size="sm" />
              ) : null}
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">
                  {wallet.label ?? formatCustodyProviderName(wallet.provider ?? "wallet")}
                </span>
                <span className="truncate font-mono text-xs text-secondary">
                  {wallet.publicKey}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {verified ? (
                <>
                  <ChannelBalance balance={channelBalances[wallet.publicKey]} t={t} />
                  <Badge variant="success">
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2Icon className="size-3" />
                      {t("DashboardPrivateChannels.verifiedWallets.verified")}
                    </span>
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("DashboardPrivateChannels.verifiedWallets.revokeAria", {
                      pubkey: wallet.publicKey,
                    })}
                    title={t("DashboardPrivateChannels.verifiedWallets.revokeTitle")}
                    disabled={pending && pendingKey === wallet.publicKey}
                    onClick={() => handleDelete(wallet.publicKey)}
                  >
                    {pending && pendingKey === wallet.publicKey ? (
                      <Loader2Icon className="animate-spin" />
                    ) : (
                      <Trash2Icon />
                    )}
                  </Button>
                </>
              ) : (
                <Button
                  disabled={pending && pendingKey === wallet.walletId}
                  onClick={() => handleVerify(wallet.walletId, wallet.publicKey)}
                >
                  {pending && pendingKey === wallet.walletId ? (
                    <Loader2Icon className="animate-spin" />
                  ) : null}
                  {t("DashboardPrivateChannels.verifiedWallets.verify")}
                </Button>
              )}
            </div>
          </li>
        );
      })}

      {orphanedVerified.map((w) => (
        <li key={w.id} className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-secondary text-xs">{w.pubkey}</span>
            <span className="text-xs text-secondary">
              {t("DashboardPrivateChannels.verifiedWallets.orphaned")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ChannelBalance balance={channelBalances[w.pubkey]} t={t} />
            <Badge variant="success">
              {t("DashboardPrivateChannels.verifiedWallets.verified")}
            </Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("DashboardPrivateChannels.verifiedWallets.revokeAria", {
                pubkey: w.pubkey,
              })}
              title={t("DashboardPrivateChannels.verifiedWallets.revokeTitle")}
              disabled={pending && pendingKey === w.pubkey}
              onClick={() => handleDelete(w.pubkey)}
            >
              {pending && pendingKey === w.pubkey ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <Trash2Icon />
              )}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
