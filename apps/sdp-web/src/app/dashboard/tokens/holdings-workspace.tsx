"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { TokenMark } from "@/components/token-mark";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  resolveTransferTokenLabel,
} from "../payments/payments-overview.utils";
import { tokenActivityHref } from "./holdings-links";
import { buildHoldingsRows } from "./holdings-rows";

/**
 * Every token an organization holds.
 *
 * The home allocation card caps at four priced and four unpriced holdings so it
 * stays a summary, which left an organization holding a dozen tokens looking at a
 * count with nothing behind it. This is what that count opens, so it caps nothing.
 */
export function HoldingsWorkspace({ balances }: { balances: CustodyWalletTokenBalance[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const rows = buildHoldingsRows(balances);

  // Balances carry their own symbols, so a token the catalogue has never heard of
  // is still named rather than falling back to a shortened mint.
  const symbolsByMint = Object.fromEntries(
    balances.map((balance) => [balance.mint, balance.token])
  );

  if (rows.length === 0) {
    return (
      <Card className="min-w-0">
        <CardContent className="py-10 text-center text-sm text-secondary">
          {t("Shared.homeWorkspace.holdingsEmpty")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="w-full space-y-4 py-2">
      <p className="text-sm text-tertiary">
        {rows.length === 1
          ? t("Shared.homeWorkspace.holdingsCountSingle")
          : t("Shared.homeWorkspace.holdingsCount", { count: rows.length })}
      </p>
      <Card className="min-w-0 overflow-hidden">
        <CardContent className="px-0">
          <Table className="min-w-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t("Shared.homeWorkspace.holdingsToken")}</TableHead>
                <TableHead className="text-right">
                  {t("Shared.homeWorkspace.holdingsAmount")}
                </TableHead>
                <TableHead className="hidden text-right sm:table-cell">
                  {t("Shared.homeWorkspace.holdingsShare")}
                </TableHead>
                <TableHead className="pr-6 text-right">
                  {t("Shared.homeWorkspace.holdingsValue")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const symbol = resolveTransferTokenLabel(row.mint, symbolsByMint) ?? row.token;
                return (
                  <TableRow key={row.mint}>
                    <TableCell className="pl-6">
                      {/* The transactions table already filters by asset, so a
                          holding's history is a link into that filter rather than
                          a second surface showing the same rows. */}
                      <DashboardNavigationLink
                        href={tokenActivityHref(row.mint)}
                        className="flex min-w-0 items-center gap-3 hover:underline"
                      >
                        <TokenMark mint={row.mint} symbol={symbol} size="sm" />
                        <span className="min-w-0 truncate font-medium text-primary">{symbol}</span>
                      </DashboardNavigationLink>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-secondary">
                      {formatDisplayAmount(row.uiAmount, symbol)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-tertiary sm:table-cell">
                      {/* Unpriced holdings are not part of the priced total, so they
                          get an em dash rather than 0% — which reads as worthless
                          rather than unmeasured. A priced share below one percent
                          rounds to "<1%" for the same reason. */}
                      {row.sharePercent === null
                        ? t("Shared.homeWorkspace.holdingsShareUnmeasured")
                        : row.sharePercent > 0 && row.sharePercent < 1
                          ? t("Shared.homeWorkspace.holdingsShareBelowOne")
                          : t("Shared.homeWorkspace.holdingsSharePercent", {
                              percent: Math.round(row.sharePercent),
                            })}
                    </TableCell>
                    <TableCell className="pr-6 text-right font-medium tabular-nums text-primary">
                      {row.usdValue === null
                        ? t("Shared.homeWorkspace.holdingsNotPriced")
                        : formatCurrencyAmount(row.usdValue, locale)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
