"use client";

import type { TokenTransaction } from "@sdp/types";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "./token-management-workspace.utils";

interface TokenTransactionsSectionProps {
  transactions: TokenTransaction[];
  transactionsError: string | null;
  transactionsTotal: number | null;
  transactionsHasMore: boolean;
  isLoading?: boolean;
}

export function TokenTransactionsSection({
  transactions,
  transactionsError,
  transactionsTotal,
  transactionsHasMore,
  isLoading = false,
}: TokenTransactionsSectionProps) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Transactions</CardTitle>
        <CardDescription>Recent token operations</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-6 py-10">
            <div className="flex items-center gap-3 text-sm text-[rgba(28,28,29,0.64)]">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading operations history…</span>
            </div>
          </div>
        ) : transactionsError ? (
          <p className="text-sm text-[#8a1f2a]">{transactionsError}</p>
        ) : transactions.length === 0 ? (
          <p className="text-sm text-[rgba(28,28,29,0.68)]">No transactions yet.</p>
        ) : (
          <div className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Signature</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.slice(0, 12).map((transaction) => (
                  <TableRow key={transaction.id} data-testid={`transaction-row-${transaction.id}`}>
                    <TableCell>{transaction.type}</TableCell>
                    <TableCell>{transaction.status}</TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs">
                      {transaction.signature ?? "—"}
                    </TableCell>
                    <TableCell>{formatDate(transaction.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {transactionsHasMore ? (
              <p className="text-xs text-[rgba(28,28,29,0.62)]">
                Showing first {transactions.length} transactions
                {transactionsTotal ? ` of ${transactionsTotal}` : ""}. Use pagination to view older
                records.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
