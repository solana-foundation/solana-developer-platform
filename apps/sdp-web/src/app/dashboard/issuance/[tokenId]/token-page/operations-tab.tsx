"use client";

import type { TokenTransactionStatus } from "@sdp/types";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { formatDecimalAmount } from "@/app/dashboard/payments/payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "@/app/dashboard/payments/payments-table";
import { RecordBlock, RecordLine, RecordStack } from "@/components/refresh-record";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { isOnChain } from "../../issuance-token-state.redesign";
import {
  getOperationGroups,
  getOperationLabels,
  type OperationAction,
  type OperationRow,
} from "../asset-profile/tabs/operation-rows.model";
import { OpsActionForms } from "../asset-profile/tabs/ops-action-forms";
import {
  fetchTokenTransactionsPage,
  type TokenTransactionsPage,
} from "../asset-profile/transactions.data";
import { TOKEN_TRANSACTIONS_KEY } from "../asset-profile/transactions-cache";
import { activityEventLabel } from "./token-activity";
import {
  accessControlLabel,
  holderName,
  shortAddress,
  type TokenTab,
  type TokenTabProps,
  transactionExplorerHref,
} from "./token-page.shared";

const TRANSACTIONS_PAGE_SIZE = 10;

// The design's wording for each operation; rows keep the shared model's gating and handlers.
const OPERATION_COPY: Record<string, { title: MessageKey; desc: MessageKey; action: MessageKey }> =
  {
    mint: {
      title: "DashboardIssuance.newDesign.operations.mintTitle",
      desc: "DashboardIssuance.newDesign.operations.mintDesc",
      action: "DashboardIssuance.newDesign.operations.mintAction",
    },
    burn: {
      title: "DashboardIssuance.newDesign.operations.burnTitle",
      desc: "DashboardIssuance.newDesign.operations.burnDesc",
      action: "DashboardIssuance.newDesign.operations.burnAction",
    },
    pause: {
      title: "DashboardIssuance.newDesign.operations.pauseTitle",
      desc: "DashboardIssuance.newDesign.operations.pauseDesc",
      action: "DashboardIssuance.newDesign.operations.pauseAction",
    },
    resume: {
      title: "DashboardIssuance.newDesign.operations.resumeTitle",
      desc: "DashboardIssuance.newDesign.operations.resumeDesc",
      action: "DashboardIssuance.newDesign.operations.resumeAction",
    },
    freeze: {
      title: "DashboardIssuance.newDesign.operations.freezeTitle",
      desc: "DashboardIssuance.newDesign.operations.freezeDesc",
      action: "DashboardIssuance.newDesign.operations.freezeAction",
    },
    allowlist: {
      title: "DashboardIssuance.newDesign.operations.listTitle",
      desc: "DashboardIssuance.newDesign.operations.listDesc",
      action: "DashboardIssuance.newDesign.operations.listAction",
    },
    seize: {
      title: "DashboardIssuance.newDesign.operations.seizeTitle",
      desc: "DashboardIssuance.newDesign.operations.seizeDesc",
      action: "DashboardIssuance.newDesign.operations.seizeAction",
    },
    "force-burn": {
      title: "DashboardIssuance.newDesign.operations.forceBurnTitle",
      desc: "DashboardIssuance.newDesign.operations.forceBurnDesc",
      action: "DashboardIssuance.newDesign.operations.forceBurnAction",
    },
    "lock-supply": {
      title: "DashboardIssuance.newDesign.operations.lockTitle",
      desc: "DashboardIssuance.newDesign.operations.lockDesc",
      action: "DashboardIssuance.newDesign.operations.lockAction",
    },
  };

const PAUSE = "pause";
const RESUME = "resume";
const DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

const DANGER_OPERATIONS = new Set(["burn", "seize", "force-burn", "lock-supply"]);

const TRANSACTION_STATUS_LABEL: Record<TokenTransactionStatus, MessageKey> = {
  pending: "DashboardIssuance.newDesign.operations.txStatuses.pending",
  processing: "DashboardIssuance.newDesign.operations.txStatuses.processing",
  confirmed: "DashboardIssuance.newDesign.operations.txStatuses.confirmed",
  finalized: "DashboardIssuance.newDesign.operations.txStatuses.finalized",
  failed: "DashboardIssuance.newDesign.operations.txStatuses.failed",
};

const TRANSACTION_TONE: Record<string, StatusTone> = {
  confirmed: "positive",
  finalized: "positive",
  pending: "progress",
  processing: "progress",
  failed: "critical",
};

/**
 * What can be done to the token on chain: its supply and transfers, each with the facts that
 * govern it and the operations that change it, recovery behind a fold, and the token's own
 * on-chain transactions.
 */
export function TokenOperationsTab({
  token,
  ops,
  state,
  canManageTokenAdmin,
  onOpenTab,
}: TokenTabProps & { onOpenTab: (tab: TokenTab) => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const [activeAction, setActiveAction] = useState<OperationAction | null>(null);
  const labels = getOperationLabels(token, t);
  const { supply, transfers, recovery } = getOperationGroups({
    ops,
    token,
    canManageTokenAdmin,
    t,
    onSelect: (action) =>
      action === "allowlist" ? onOpenTab("compliance") : setActiveAction(action),
    labels,
  });
  const onChain = isOnChain(state);
  const blockedNote =
    state === "deploying"
      ? t("DashboardIssuance.newDesign.operations.deployingNote")
      : state === "failed"
        ? t("DashboardIssuance.newDesign.operations.failedNote")
        : !onChain
          ? t("DashboardIssuance.newDesign.operations.draftNote")
          : state === "revoked"
            ? t("DashboardIssuance.newDesign.operations.revokedNote")
            : null;
  const holder = (address: string | null | undefined) =>
    holderName(address, ops.authorityWallets, t);
  const issued = Number(token.totalSupply || 0);
  const cap = token.maxSupply ? Number(token.maxSupply) : null;
  const left = cap !== null && Number.isFinite(cap) ? Math.max(0, cap - issued) : null;
  const decimals = Math.min(Math.max(token.decimals, 2), 9);

  return (
    <RecordStack>
      {blockedNote ? <p className="max-w-[40em] text-body text-secondary">{blockedNote}</p> : null}

      <RecordBlock title={t("DashboardIssuance.newDesign.operations.supply")}>
        <dl>
          <RecordLine label={t("DashboardIssuance.newDesign.overview.issuedSupply")}>
            <span>{formatDecimalAmount(token.totalSupply || "0", locale)}</span>
            <span className="rounded-control bg-fill-subtle px-1.5 text-meta text-secondary">
              {token.symbol}
            </span>
          </RecordLine>
          <RecordLine label={t("DashboardIssuance.newDesign.overview.supplyCap")}>
            {cap === null
              ? t("DashboardIssuance.newDesign.overview.noCap")
              : t("DashboardIssuance.newDesign.operations.capLeft", {
                  cap: formatDecimalAmount(token.maxSupply ?? "0", locale),
                  left: new Intl.NumberFormat(locale, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: decimals,
                  }).format(left ?? 0),
                })}
          </RecordLine>
          <RecordLine label={t("DashboardIssuance.newDesign.operations.mintAuthority")}>
            {holder(token.mintAuthority)}
          </RecordLine>
        </dl>
        {onChain ? <OperationRows rows={supply} pending={ops.isPending} /> : null}
      </RecordBlock>

      <RecordBlock title={t("DashboardIssuance.newDesign.operations.transfers")}>
        <dl>
          <RecordLine label={t("DashboardIssuance.newDesign.operations.transfers")}>
            {state === "paused"
              ? t("DashboardIssuance.newDesign.operations.transfersPaused")
              : onChain
                ? t("DashboardIssuance.newDesign.operations.transfersRunning")
                : t("DashboardIssuance.newDesign.publicInfo.notDeployed")}
          </RecordLine>
          {token.isFreezable ? (
            <RecordLine label={t("DashboardIssuance.newDesign.operations.freezeAuthority")}>
              {holder(token.freezeAuthority)}
            </RecordLine>
          ) : null}
          <RecordLine label={t("DashboardIssuance.newDesign.overview.accessControl")}>
            {accessControlLabel(ops.accessControlMode, t)}
          </RecordLine>
        </dl>
        {onChain ? (
          <OperationRows rows={transfers} pending={ops.isPending} paused={state === "paused"} />
        ) : null}
      </RecordBlock>

      {onChain && recovery.length > 0 ? (
        <details className="group/recovery">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-subheading font-medium text-primary [&::-webkit-details-marker]:hidden">
            {t("DashboardIssuance.newDesign.operations.recovery")}
            <ChevronDownIcon
              aria-hidden="true"
              className="size-4 text-secondary transition-transform group-open/recovery:rotate-180"
            />
          </summary>
          <div className="mt-5">
            <OperationRows rows={recovery} pending={ops.isPending} />
          </div>
        </details>
      ) : null}

      <TokenTransactions tokenId={token.id} />

      <Modal
        isOpen={Boolean(activeAction)}
        ariaLabel={
          activeAction ? labels[activeAction] : t("DashboardIssuance.management.operations")
        }
        onClose={() => setActiveAction(null)}
        closeDisabled={ops.isPending}
        size="xl"
        contentClassName="p-6 [&_[data-slot=card-header]]:pr-10"
      >
        {activeAction ? (
          <OpsActionForms
            token={token}
            activeAction={activeAction}
            ops={{
              ...ops,
              handleSeize: () => {
                setActiveAction(null);
                ops.handleSeize();
              },
              handleForceBurn: () => {
                setActiveAction(null);
                ops.handleForceBurn();
              },
              handleFreeze: (freeze) => {
                setActiveAction(null);
                ops.handleFreeze(freeze);
              },
            }}
            formVariant="bare"
            submitAlignment="end"
          />
        ) : null}
      </Modal>
    </RecordStack>
  );
}

/** Operation rows: what each does and, when it cannot run, why; its button at the end. */
function OperationRows({
  rows,
  pending,
  paused = false,
}: {
  rows: OperationRow[];
  pending: boolean;
  paused?: boolean;
}) {
  const t = useTranslations();
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col">
      {rows.map(({ icon: Icon, ...row }) => {
        const copy = OPERATION_COPY[row.id === PAUSE && paused ? RESUME : row.id];
        return (
          <div
            key={row.id}
            data-token-operation={row.id}
            className="flex flex-col items-start gap-3 border-b border-border-subtle py-4 first:pt-0 last:border-b-0 @xl:flex-row @xl:justify-between"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-body font-medium text-primary">
                {copy ? t(copy.title) : row.title}
              </span>
              <span className="max-w-[40em] text-meta text-secondary">
                {copy ? t(copy.desc) : row.helper}
              </span>
              {row.disabledReason ? (
                <span className="mt-1 max-w-[40em] text-meta text-tertiary">
                  {row.disabledReason}
                </span>
              ) : null}
            </span>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "shrink-0 [--button-height-md:1.875rem]",
                DANGER_OPERATIONS.has(row.id) && "text-error refresh:border-error/40"
              )}
              disabled={pending || Boolean(row.disabledReason)}
              onClick={row.onAction}
              iconLeft={<Icon aria-hidden="true" />}
            >
              {copy ? t(copy.action) : (row.actionLabel ?? row.title)}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function TokenTransactions({ tokenId }: { tokenId: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const { data, error } = useSWR<TokenTransactionsPage, Error>(
    [TOKEN_TRANSACTIONS_KEY, tokenId, page, TRANSACTIONS_PAGE_SIZE, "redesign"],
    () => fetchTokenTransactionsPage(tokenId, { page, pageSize: TRANSACTIONS_PAGE_SIZE }),
    { keepPreviousData: true }
  );
  const dateTime = useMemo(() => new Intl.DateTimeFormat(locale, DATE_TIME_FORMAT), [locale]);
  const transactions = data?.transactions ?? [];
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / TRANSACTIONS_PAGE_SIZE));

  return (
    <RecordBlock title={t("DashboardIssuance.newDesign.operations.transactions")}>
      {error ? (
        <p className="text-body text-error">
          {t("DashboardIssuance.newDesign.operations.transactionsFailed")}
        </p>
      ) : data && transactions.length === 0 ? (
        <div className="flex flex-col gap-1 py-2">
          <p className="text-body font-medium text-primary">
            {t("DashboardIssuance.newDesign.operations.noTransactions")}
          </p>
          <p className="max-w-[40em] text-body text-secondary">
            {t("DashboardIssuance.newDesign.operations.noTransactionsBody")}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto refresh:-mx-3">
          <Table className="min-w-[560px] table-fixed rounded-none border-0">
            <colgroup>
              <col className="w-[20%]" />
              <col className="w-[20%]" />
              <col className="w-[34%]" />
              <col className="w-[26%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardIssuance.newDesign.operations.type")}
                </TableHead>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardIssuance.newDesign.operations.status")}
                </TableHead>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardIssuance.newDesign.operations.signature")}
                </TableHead>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardIssuance.newDesign.operations.created")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((transaction) => (
                <TableRow key={transaction.id}>
                  <TableCell className={`${PAYMENTS_TABLE_CELL} truncate font-medium text-primary`}>
                    {activityEventLabel(transaction.type, t)}
                  </TableCell>
                  <TableCell className={PAYMENTS_TABLE_CELL}>
                    <StatusText tone={TRANSACTION_TONE[transaction.status] ?? "neutral"}>
                      {t(TRANSACTION_STATUS_LABEL[transaction.status])}
                    </StatusText>
                  </TableCell>
                  <TableCell className={`${PAYMENTS_TABLE_CELL} truncate tabular-nums`}>
                    {transaction.signature ? (
                      <a
                        href={transactionExplorerHref(transaction.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {shortAddress(transaction.signature)}
                        <ExternalLinkIcon className="size-3" aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="text-tertiary">
                        {transaction.status === "pending" || transaction.status === "processing"
                          ? t("DashboardIssuance.newDesign.operations.notConfirmed")
                          : t("DashboardIssuance.newDesign.operations.neverSubmitted")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className={`${PAYMENTS_TABLE_CELL} text-primary tabular-nums`}>
                    {dateTime.format(new Date(transaction.createdAt))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {pageCount > 1 ? (
        <ArrowPagination page={page} pageCount={pageCount} onPageChange={setPage} />
      ) : null}
    </RecordBlock>
  );
}
