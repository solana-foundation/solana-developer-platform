"use client";

import type { UnifiedTransaction, UnifiedTransactionStatus } from "@sdp/types";
import { ExternalLinkIcon, ReceiptTextIcon } from "lucide-react";
import { useState } from "react";
import { EntityLink } from "@/components/entity-link";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { Modal } from "@/components/ui/modal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { formatTimestamp, resolveTokenByMint } from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { TRANSACTION_MODULE_HREFS } from "./transaction-module-hrefs";
import type { TransactionsPageResult } from "./transactions-page.data";
import { useTransactionFilters } from "./transactions-workspace";
import { useCursorPagination } from "./use-cursor-pagination";

const statusVariants = {
  pending: "warning",
  succeeded: "success",
  failed: "danger",
  canceled: "outline",
} as const satisfies Record<UnifiedTransactionStatus, BadgeVariant>;

function walletHref(custodyWalletId: string): string {
  return `/dashboard/wallets/${encodeURIComponent(custodyWalletId)}`;
}

function TransactionDetail({
  transaction,
  issuedTokensByMint,
}: {
  transaction: UnifiedTransaction;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
}) {
  const t = useTranslations();
  const fields = [
    { label: t("DashboardPayments.transactions.transactionId"), value: transaction.id, href: null },
    {
      label: t("DashboardPayments.transactions.moduleId"),
      value: transaction.moduleId,
      href: null,
    },
    {
      label: t("DashboardPayments.transactions.kind"),
      value: t(
        `DashboardPayments.transactions.kinds.${transaction.module}.${transaction.kind}` as MessageKey
      ),
      href: null,
    },
    {
      label: t("DashboardPayments.transactions.status"),
      value: transaction.moduleStatus,
      href: null,
    },
    { label: t("DashboardPayments.transactions.amount"), value: transaction.amount, href: null },
    {
      label: t("DashboardPayments.transactions.token"),
      value:
        transaction.token === null
          ? null
          : resolveTokenByMint(transaction.token, issuedTokensByMint).tokenName,
      href: null,
    },
    {
      label: t("DashboardPayments.transactions.wallet"),
      value:
        transaction.custodyWalletId === null
          ? null
          : transaction.custodyWalletLabel === null
            ? transaction.custodyWalletId
            : transaction.custodyWalletLabel,
      href: transaction.custodyWalletId === null ? null : walletHref(transaction.custodyWalletId),
    },
    {
      label: t("DashboardPayments.transactions.counterparty"),
      value: transaction.counterpartyId,
      href:
        transaction.counterpartyId === null
          ? null
          : `/dashboard/payments/counterparty/${encodeURIComponent(transaction.counterpartyId)}`,
    },
    {
      label: t("DashboardPayments.transactions.signature"),
      value: transaction.signature,
      href: null,
    },
    {
      label: t("DashboardPayments.transactions.created"),
      value: transaction.createdAt,
      href: null,
    },
  ].filter((field): field is typeof field & { value: string } => field.value !== null);
  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-primary">
        {t("DashboardPayments.transactions.details")}
      </h2>
      <dl className="mt-4 divide-y divide-border-default">
        {fields.map((field) => (
          <div key={field.label} className="grid gap-2 py-3 sm:grid-cols-3">
            <dt className="text-xs text-tertiary">{field.label}</dt>
            <dd className="break-all text-sm text-primary sm:col-span-2">
              {field.href === null ? (
                field.value
              ) : (
                <EntityLink href={field.href}>{field.value}</EntityLink>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <EntityLink
        className="mt-5 text-sm"
        href={TRANSACTION_MODULE_HREFS[transaction.module](transaction.moduleId)}
      >
        {t("DashboardPayments.transactions.viewInModule", {
          module: t(`DashboardPayments.transactions.modules.${transaction.module}` as MessageKey),
        })}
      </EntityLink>
    </div>
  );
}

export function TransactionsResults({
  result,
  issuedTokensByMint,
}: {
  result: TransactionsPageResult;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const { filters, pending, navigate } = useTransactionFilters();
  const pagination = useCursorPagination(filters, result.nextCursor, navigate);
  const [selected, setSelected] = useState<UnifiedTransaction | null>(null);
  if (result.transactions.length === 0) {
    return (
      <ListEmptyState
        icon={<ReceiptTextIcon className="size-5" />}
        message={t("DashboardPayments.transactions.noTransactionsFound")}
      />
    );
  }
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-busy={pending}>
      <div className="overflow-x-auto">
        <Table className="rounded-none border-0">
          <TableHeader>
            <TableRow>
              <TableHead>{t("DashboardPayments.transactions.created")}</TableHead>
              {filters.module === undefined ? (
                <TableHead>{t("DashboardPayments.transactions.module")}</TableHead>
              ) : null}
              <TableHead>{t("DashboardPayments.transactions.kind")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.amount")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.status")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.wallet")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.signature")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.transactions.map((transaction) => (
              <TableRow
                key={`${transaction.module}:${transaction.id}`}
                onClick={() => setSelected(transaction)}
                className="cursor-pointer"
              >
                <TableCell className="text-sm text-secondary">
                  {formatTimestamp(transaction.createdAt, t, locale)}
                </TableCell>
                {filters.module === undefined ? (
                  <TableCell className="text-sm text-secondary">
                    {t(
                      `DashboardPayments.transactions.modules.${transaction.module}` as MessageKey
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="text-sm text-primary">
                  {t(
                    `DashboardPayments.transactions.kinds.${transaction.module}.${transaction.kind}` as MessageKey
                  )}
                </TableCell>
                <TableCell className="text-sm text-secondary">
                  {transaction.amount === null
                    ? "—"
                    : transaction.token === null
                      ? transaction.amount
                      : `${transaction.amount} ${resolveTokenByMint(transaction.token, issuedTokensByMint).tokenName}`}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariants[transaction.status]}>
                    {transaction.moduleStatus}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-secondary">
                  {transaction.custodyWalletId === null ? (
                    "—"
                  ) : (
                    <EntityLink href={walletHref(transaction.custodyWalletId)}>
                      {transaction.custodyWalletLabel === null
                        ? transaction.custodyWalletId
                        : transaction.custodyWalletLabel}
                    </EntityLink>
                  )}
                </TableCell>
                <TableCell className="max-w-48 text-sm text-secondary">
                  {transaction.signature === null ? (
                    "—"
                  ) : (
                    <a
                      href={explorerTxUrl(transaction.signature, cluster)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                      className="flex min-w-0 items-center gap-1 text-primary underline underline-offset-2"
                    >
                      <span className="block min-w-0 truncate">{transaction.signature}</span>
                      <ExternalLinkIcon className="size-3 shrink-0" />
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ArrowPagination
        className="mt-auto border-t border-border-default p-3"
        page={pagination.page}
        pageCount={pagination.pageCount}
        disabled={pending}
        onPageChange={pagination.goToPage}
      />
      <Modal
        isOpen={selected !== null}
        onClose={() => setSelected(null)}
        ariaLabel={t("DashboardPayments.transactions.details")}
        size="xl"
      >
        {selected === null ? null : (
          <TransactionDetail transaction={selected} issuedTokensByMint={issuedTokensByMint} />
        )}
      </Modal>
    </section>
  );
}
