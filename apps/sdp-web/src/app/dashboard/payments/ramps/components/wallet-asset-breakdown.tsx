"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { motion } from "motion/react";
import {
  formatCurrencyAmount,
  resolveUsdBalanceValue,
} from "@/app/dashboard/payments/payments-overview.utils";

interface BreakdownRow {
  token: string;
  amount: number;
  usdValue: number | null;
}

function breakdownRows(wallet: PaymentsDashboardWallet): BreakdownRow[] {
  const rows = (wallet.balances ?? []).flatMap((balance) => {
    const amount = Number(balance.uiAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return [];
    }
    return [
      {
        token: balance.token.trim().toUpperCase(),
        amount,
        usdValue: resolveUsdBalanceValue(balance),
      },
    ];
  });
  return rows.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
}

function formatTwoDecimals(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function WalletAssetBreakdown({ wallet }: { wallet: PaymentsDashboardWallet }) {
  const rows = breakdownRows(wallet);
  if (rows.length === 0) {
    return null;
  }

  const totalUsd = rows.reduce((sum, row) => sum + (row.usdValue ?? 0), 0);

  return (
    <motion.div
      key={wallet.walletId}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="space-y-5 pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium tracking-tight text-text-extra-high">Asset breakdown</h2>
        {totalUsd > 0 ? (
          <p className="text-sm text-text-low">{formatCurrencyAmount(totalUsd)} total</p>
        ) : null}
      </div>
      <div className="space-y-6">
        {rows.map((row, index) => {
          const shareValue =
            row.usdValue !== null && totalUsd > 0 ? (row.usdValue / totalUsd) * 100 : null;
          return (
            <motion.div
              key={row.token}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: "easeOut", delay: index * 0.06 }}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-baseline gap-2">
                  <p className="text-base font-medium text-text-extra-high">{row.token}</p>
                  {row.usdValue !== null ? (
                    <p className="text-sm text-text-low">{formatCurrencyAmount(row.usdValue)}</p>
                  ) : null}
                </div>
                <p className="shrink-0 text-sm text-text-medium">
                  {formatTwoDecimals(row.amount)}
                  {shareValue !== null ? ` · ${formatTwoDecimals(shareValue)}%` : ""}
                </p>
              </div>
              {shareValue !== null ? (
                <div className="mt-3 h-1.5 w-full rounded-full bg-border-light">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${shareValue}%` }}
                    transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 + index * 0.06 }}
                    className="h-1.5 rounded-full bg-gray-1400"
                  />
                </div>
              ) : null}
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}
