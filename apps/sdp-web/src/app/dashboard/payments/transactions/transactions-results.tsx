"use client";

import {
  PAYMENT_TRANSFER_STATUSES,
  type PaymentTransferStatus,
  type UnifiedTransaction,
  type UnifiedTransactionStatus,
} from "@sdp/types";
import { ReceiptTextIcon } from "lucide-react";
import { useState } from "react";
import { EntityLink } from "@/components/entity-link";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { Modal } from "@/components/ui/modal";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
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
import { resolveTokenByMint, shortenAddress, statusMessageKey } from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { formatDateTime, formatDecimalAmount, PAYMENT_STATUS_TONE } from "../payments-presentation";
import { counterpartyHref, TRANSACTION_MODULE_HREFS, walletHref } from "./transaction-module-hrefs";
import type { TransactionsPageResult } from "./transactions-page.data";
import { useTransactionFilters } from "./transactions-workspace";
import { useCursorPagination } from "./use-cursor-pagination";

const UNIFIED_STATUS_TONE = {
  pending: "attention",
  succeeded: "positive",
  failed: "critical",
  canceled: "neutral",
} as const satisfies Record<UnifiedTransactionStatus, StatusTone>;

function isPaymentTransferStatus(status: string): status is PaymentTransferStatus {
  return PAYMENT_TRANSFER_STATUSES.some((candidate) => candidate === status);
}

/**
 * A row's status in words and tone. Payments rows keep their own state ("Settling",
 * "Awaiting payment"); other modules read by the ledger's four-way status, since their module
 * states have no copy here.
 */
function useTransactionStatus() {
  const t = useTranslations();
  return (transaction: UnifiedTransaction): { label: string; tone: StatusTone } =>
    transaction.module === "payments" && isPaymentTransferStatus(transaction.moduleStatus)
      ? {
          label: t(statusMessageKey(transaction.moduleStatus)),
          tone: PAYMENT_STATUS_TONE[transaction.moduleStatus],
        }
      : {
          label: t(`DashboardPayments.transactions.statuses.${transaction.status}` as MessageKey),
          tone: UNIFIED_STATUS_TONE[transaction.status],
        };
}

function kindLabel(t: ReturnType<typeof useTranslations>, transaction: UnifiedTransaction) {
  return t(
    `DashboardPayments.transactions.kinds.${transaction.module}.${transaction.kind}` as MessageKey
  );
}

function TransactionDetail({
  transaction,
  issuedTokensByMint,
  counterpartyName,
}: {
  transaction: UnifiedTransaction;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  counterpartyName: string | undefined;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const status = useTransactionStatus()(transaction);
  const fields = [
    { label: t("DashboardPayments.transactions.transactionId"), value: transaction.id, href: null },
    {
      label: t("DashboardPayments.transactions.moduleId"),
      value: transaction.moduleId,
      href: null,
    },
    {
      label: t("DashboardPayments.transactions.module"),
      value: t(`DashboardPayments.transactions.modules.${transaction.module}` as MessageKey),
      href: null,
    },
    {
      label: t("DashboardPayments.transactions.kind"),
      value: kindLabel(t, transaction),
      href: null,
    },
    { label: t("DashboardPayments.transactions.status"), value: status.label, href: null },
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
          : (transaction.custodyWalletLabel ?? transaction.custodyWalletId),
      href: transaction.custodyWalletId === null ? null : walletHref(transaction.custodyWalletId),
    },
    {
      label: t("DashboardPayments.transactions.counterparty"),
      value:
        transaction.counterpartyId === null
          ? null
          : (counterpartyName ?? transaction.counterpartyId),
      href:
        transaction.counterpartyId === null ? null : counterpartyHref(transaction.counterpartyId),
    },
    {
      label: t("DashboardPayments.transactions.signature"),
      value: transaction.signature,
      href: null,
    },
    {
      label: t("DashboardPayments.transactions.created"),
      value: formatDateTime(transaction.createdAt, locale) ?? transaction.createdAt,
      href: null,
    },
  ].filter((field): field is typeof field & { value: string } => field.value !== null);
  return (
    <div className="p-6">
      <h2 className="text-subheading font-medium text-primary">
        {t("DashboardPayments.transactions.details")}
      </h2>
      <dl className="mt-4 divide-y divide-border-subtle">
        {fields.map((field) => (
          <div key={field.label} className="grid gap-2 py-3 sm:grid-cols-3">
            <dt className="text-meta text-secondary">{field.label}</dt>
            <dd className="break-all text-body text-primary sm:col-span-2">
              {field.href === null ? (
                field.value
              ) : (
                <EntityLink href={field.href}>{field.value}</EntityLink>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {transaction.module !== "payments" && (
        <EntityLink
          className="mt-5 text-sm"
          href={TRANSACTION_MODULE_HREFS[transaction.module](transaction.moduleId)}
        >
          {t("DashboardPayments.transactions.viewInModule", {
            module: t(`DashboardPayments.transactions.modules.${transaction.module}` as MessageKey),
          })}
        </EntityLink>
      )}
    </div>
  );
}

export function TransactionsResults({
  result,
  issuedTokensByMint,
  counterpartyNames,
}: {
  result: TransactionsPageResult;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  counterpartyNames: ReadonlyMap<string, string>;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const statusOf = useTransactionStatus();
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
      <div className="overflow-x-auto refresh:-mx-3">
        <Table className="min-w-[760px] rounded-none border-0">
          <TableHeader>
            <TableRow>
              <TableHead>{t("DashboardPayments.transactions.status")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.type")}</TableHead>
              <TableHead className="text-right">
                {t("DashboardPayments.transactions.amount")}
              </TableHead>
              <TableHead>{t("DashboardPayments.transactions.contact")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.wallet")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.created")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.transactions.map((transaction) => {
              const status = statusOf(transaction);
              const token =
                transaction.token === null
                  ? null
                  : resolveTokenByMint(transaction.token, issuedTokensByMint).tokenName;
              const contact =
                transaction.counterpartyId === null
                  ? null
                  : (counterpartyNames.get(transaction.counterpartyId) ??
                    shortenAddress(transaction.counterpartyId));
              const wallet =
                transaction.custodyWalletId === null
                  ? null
                  : (transaction.custodyWalletLabel ?? shortenAddress(transaction.custodyWalletId));
              return (
                <TableRow
                  key={`${transaction.module}:${transaction.id}`}
                  onClick={() => setSelected(transaction)}
                  className="cursor-pointer"
                >
                  <TableCell>
                    <StatusText tone={status.tone} className="text-body">
                      {status.label}
                    </StatusText>
                  </TableCell>
                  <TableCell className="text-body text-secondary">
                    {kindLabel(t, transaction)}
                  </TableCell>
                  <TableCell className="text-right text-body whitespace-nowrap tabular-nums">
                    {transaction.amount === null ? (
                      <span className="text-tertiary">—</span>
                    ) : (
                      <>
                        <span className="text-primary">
                          {formatDecimalAmount(transaction.amount, locale)}
                        </span>
                        {token === null ? null : <span className="text-secondary"> {token}</span>}
                      </>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-48 truncate text-body text-primary"
                    title={contact ?? undefined}
                  >
                    {contact ?? <span className="text-tertiary">—</span>}
                  </TableCell>
                  <TableCell
                    className="max-w-44 truncate text-body text-secondary"
                    title={wallet ?? undefined}
                  >
                    {wallet ?? <span className="text-tertiary">—</span>}
                  </TableCell>
                  <TableCell className="text-body whitespace-nowrap text-secondary">
                    {formatDateTime(transaction.createdAt, locale)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ArrowPagination
        className="mt-4"
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
          <TransactionDetail
            transaction={selected}
            issuedTokensByMint={issuedTokensByMint}
            counterpartyName={
              selected.counterpartyId === null
                ? undefined
                : counterpartyNames.get(selected.counterpartyId)
            }
          />
        )}
      </Modal>
    </section>
  );
}
