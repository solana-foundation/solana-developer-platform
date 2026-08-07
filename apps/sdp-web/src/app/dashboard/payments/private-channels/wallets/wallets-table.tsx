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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

type Translate = ReturnType<typeof useTranslations>;

/** Channel balance for a wallet, or a dash when the gateway read is unavailable. */
function balanceLabel(t: Translate, balance: WalletChannelBalance | undefined): string {
  if (!balance) return t("DashboardPrivateChannels.overview.valueNone");
  const known = WELL_KNOWN_TOKEN_BY_MINT.get(balance.mint);
  const symbol = known?.symbol ?? shortKey(balance.mint);
  return t("DashboardPrivateChannels.verifiedWallets.channelBalanceAmount", {
    amount: balance.uiAmount,
    symbol,
  });
}

export function WalletsTable({
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
  // Keep revoke reachable for verifications whose custody wallet is no longer listed.
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardPrivateChannels.overview.walletsTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <p className="text-sm text-error">
            {t("DashboardPrivateChannels.verifiedWallets.loadError")}
          </p>
        ) : custodyWallets.length === 0 && orphanedVerified.length === 0 ? (
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
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardPrivateChannels.overview.colWallet")}</TableHead>
                <TableHead>{t("DashboardPrivateChannels.overview.colBalance")}</TableHead>
                <TableHead>{t("DashboardPrivateChannels.overview.colStatus")}</TableHead>
                <TableHead align="right"> </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {custodyWallets.map((wallet) => {
                const verified = verifiedByPubkey.get(wallet.publicKey);
                const busy =
                  pending && pendingKey === (verified ? wallet.publicKey : wallet.walletId);
                return (
                  <TableRow key={wallet.walletId}>
                    <TableCell>
                      <span className="flex min-w-0 items-center gap-3">
                        {wallet.provider && isKnownCustodyProvider(wallet.provider) ? (
                          <WalletProviderMark provider={wallet.provider} size="sm" />
                        ) : null}
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            {wallet.label ?? formatCustodyProviderName(wallet.provider ?? "wallet")}
                          </span>
                          <span className="truncate text-xs text-secondary">
                            {shortKey(wallet.publicKey)}
                          </span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-secondary tabular-nums">
                      {balanceLabel(t, channelBalances[wallet.publicKey])}
                    </TableCell>
                    <TableCell>
                      {verified ? (
                        <Badge variant="success">
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2Icon className="size-3" />
                            {t("DashboardPrivateChannels.verifiedWallets.verified")}
                          </span>
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => handleVerify(wallet.walletId, wallet.publicKey)}
                        >
                          {busy ? <Loader2Icon className="animate-spin" /> : null}
                          {t("DashboardPrivateChannels.verifiedWallets.verify")}
                        </Button>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {verified ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("DashboardPrivateChannels.verifiedWallets.revokeAria", {
                            pubkey: wallet.publicKey,
                          })}
                          title={t("DashboardPrivateChannels.verifiedWallets.revokeTitle")}
                          disabled={busy}
                          onClick={() => handleDelete(wallet.publicKey)}
                        >
                          {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}

              {orphanedVerified.map((w) => {
                const busy = pending && pendingKey === w.pubkey;
                return (
                  <TableRow key={w.id}>
                    <TableCell>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-secondary">{shortKey(w.pubkey)}</span>
                        <span className="text-xs text-tertiary">
                          {t("DashboardPrivateChannels.verifiedWallets.orphaned")}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-secondary tabular-nums">
                      {balanceLabel(t, channelBalances[w.pubkey])}
                    </TableCell>
                    <TableCell>
                      <Badge variant="success">
                        {t("DashboardPrivateChannels.verifiedWallets.verified")}
                      </Badge>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("DashboardPrivateChannels.verifiedWallets.revokeAria", {
                          pubkey: w.pubkey,
                        })}
                        title={t("DashboardPrivateChannels.verifiedWallets.revokeTitle")}
                        disabled={busy}
                        onClick={() => handleDelete(w.pubkey)}
                      >
                        {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
