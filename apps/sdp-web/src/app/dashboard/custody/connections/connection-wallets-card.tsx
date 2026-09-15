"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import Link from "next/link";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatWalletMeta } from "@/app/dashboard/custody/wallet-format-utils";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";

/**
 * Formats a wallet's headline balance.
 *
 * Shows the largest holding rather than a total: the tokens are different
 * assets and summing them would invent a number. Wallets whose balances could
 * not be read show nothing rather than a zero, which would be a claim.
 */
function formatCreated(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function balanceLabel(wallet: CustodyWalletSummary): string | null {
  const balances = wallet.balances;
  if (!balances || balances.length === 0) return null;
  const largest = [...balances].sort(
    (left, right) => Number(right.uiAmount) - Number(left.uiAmount)
  )[0];
  if (!largest) return null;
  return `${largest.uiAmount} ${largest.token}`;
}

/**
 * The connection's wallets, read-only.
 *
 * Read-only on purpose: wallets already have a page of their own that owns
 * every action on them, and duplicating those controls here would give the same
 * operation two homes that could disagree. A row is a link to that page.
 */
export function ConnectionWalletsCard({
  wallets,
  walletsUnavailable,
  isDeactivated,
  pendingWalletLabel,
  defaultWalletId,
}: {
  wallets: CustodyWalletSummary[];
  walletsUnavailable: boolean;
  isDeactivated: boolean;
  pendingWalletLabel: string | null;
  defaultWalletId: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
      <h2 className="text-base font-medium text-primary">{t("DashboardCustody.wallets")}</h2>
      <div className="mt-3 overflow-hidden rounded-xl border border-border-default">
        <Table className="[&_table]:w-full [&_table]:min-w-0 [&_table]:table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40%]">{t("DashboardCustody.wallet")}</TableHead>
              <TableHead className="w-[24%]">{t("DashboardCustody.balance")}</TableHead>
              <TableHead className="w-[20%]">{t("DashboardCustody.status")}</TableHead>
              <TableHead className="hidden w-[16%] @2xl/connection-wallets:table-cell">
                {t("DashboardCustody.created")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {wallets.map((wallet) => (
              <TableRow key={wallet.walletId} data-wallet-id={wallet.walletId}>
                <TableCell className="font-medium">
                  <span className="flex min-w-0 items-center gap-2">
                    <Link
                      href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}
                      className="truncate hover:underline"
                    >
                      {wallet.label?.trim() || wallet.walletId}
                    </Link>
                    {defaultWalletId === wallet.walletId ? (
                      <Badge variant="outline">{t("DashboardCustody.defaultBadge")}</Badge>
                    ) : null}
                  </span>
                  <span className="mt-1 flex items-center gap-1">
                    <span className="truncate font-mono text-[11px] font-normal text-tertiary">
                      {formatWalletMeta(wallet.publicKey)}
                    </span>
                    <WalletAddressCopyButton
                      address={wallet.publicKey}
                      tooltip={wallet.publicKey}
                    />
                  </span>
                </TableCell>
                <TableCell className="text-xs text-secondary">
                  {balanceLabel(wallet) ?? "—"}
                </TableCell>
                <TableCell className="text-xs">
                  {/* A wallet on an ended connection cannot sign through it any
                      more, whatever its own row still says. */}
                  {isDeactivated ? (
                    <Badge variant="outline">{t("DashboardCustody.walletReadOnly")}</Badge>
                  ) : (
                    <Badge variant={wallet.status === "active" ? "success" : "outline"}>
                      {wallet.status === "active"
                        ? t("DashboardCustody.connectionStatusActive")
                        : wallet.status}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="hidden text-xs text-secondary @2xl/connection-wallets:table-cell">
                  {formatCreated(wallet.createdAt, locale)}
                </TableCell>
              </TableRow>
            ))}
            {wallets.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-tertiary">
                  {walletsUnavailable
                    ? t("DashboardCustody.connectionWalletsUnavailable")
                    : pendingWalletLabel
                      ? t("DashboardCustody.walletsPendingSetup")
                      : t("DashboardCustody.connectionNoWallets")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
