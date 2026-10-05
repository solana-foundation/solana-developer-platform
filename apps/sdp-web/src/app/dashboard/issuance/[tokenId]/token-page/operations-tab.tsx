"use client";

import type { TokenTransactionStatus } from "@sdp/types";
import { ArrowUpRightIcon, ChevronDownIcon, MinusIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import useSWR from "swr";
import { formatDecimalAmount } from "@/app/dashboard/payments/payments-presentation";
import { PAYMENTS_TABLE_CELL } from "@/app/dashboard/payments/payments-table";
import { RecordBlock, RecordStack } from "@/components/refresh-record";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Modal } from "@/components/ui/modal";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import { TableCell, TableRow } from "@/components/ui/table";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { isOnChain, type TokenLifecycle } from "../../issuance-token-state.redesign";
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
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";
import { LockSupplyForm, SupplyOperationForm } from "./supply-operation-form";
import { activityEventLabel } from "./token-activity";
import {
  accessControlLabel,
  holderName,
  shortAddress,
  type TokenTab,
  type TokenTabProps,
  transactionExplorerHref,
} from "./token-page.shared";
import { TokenTable } from "./token-table";
import { FreezeAccountForm, PauseTransfersForm } from "./transfer-operation-forms";

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
const FREEZE = "freeze";
const DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

const DANGER_OPERATIONS = new Set(["burn", "seize", "force-burn", "lock-supply"]);
const LOCK_SUPPLY = "lock-supply";
/** The operations each supply row offers: minting and burning on the issued supply, locking on the cap. */
const ISSUED_SUPPLY_OPERATIONS: ReadonlySet<string> = new Set(["mint", "burn"]);
const SUPPLY_CAP_OPERATIONS: ReadonlySet<string> = new Set([LOCK_SUPPLY]);
/** The design draws minting and burning as a plus and a minus beside the issued supply. */
const OPERATION_ICON: Record<string, typeof PlusIcon> = { mint: PlusIcon, burn: MinusIcon };

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

type Translate = ReturnType<typeof useTranslations>;

/** Why the token's operations cannot run yet, or have stopped; null while they can. */
function operationsBlockedNote(state: TokenLifecycle, onChain: boolean, t: Translate) {
  if (state === "deploying") return t("DashboardIssuance.newDesign.operations.deployingNote");
  if (state === "failed") return t("DashboardIssuance.newDesign.operations.failedNote");
  if (!onChain) return t("DashboardIssuance.newDesign.operations.draftNote");
  if (state === "revoked") return t("DashboardIssuance.newDesign.operations.revokedNote");
  return null;
}

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
  const [activeAction, setActiveAction] = useState<OperationAction | null>(null);
  const labels = getOperationLabels(token, t);
  const { supply, transfers, recovery } = getOperationGroups({
    ops,
    token,
    canManageTokenAdmin,
    t,
    onSelect: (action) => {
      if (action === "allowlist") {
        onOpenTab("compliance");
        return;
      }
      ops.prefillDemoOperation(action);
      setActiveAction(action);
    },
    labels,
  });
  const onChain = isOnChain(state);
  const blockedNote = operationsBlockedNote(state, onChain, t);
  // Locking the supply sits on the cap it fixes; the rest of recovery stays folded away.
  const lockSupply = recovery.filter((row) => row.id === LOCK_SUPPLY);
  const recoveryRows = recovery.filter((row) => row.id !== LOCK_SUPPLY);

  return (
    <RecordStack>
      {blockedNote ? <p className="max-w-[40em] text-body text-secondary">{blockedNote}</p> : null}
      <SupplyBlock token={token} ops={ops} rows={onChain ? [...supply, ...lockSupply] : null} />
      <TransfersBlock
        token={token}
        ops={ops}
        state={state}
        onChain={onChain}
        rows={onChain ? transfers : null}
      />
      {onChain && recoveryRows.length > 0 ? (
        <RecoveryFold rows={recoveryRows} pending={ops.isPending} />
      ) : null}
      <TokenTransactions tokenId={token.id} />
      <OperationModal
        token={token}
        ops={ops}
        activeAction={activeAction}
        label={activeAction ? labels[activeAction] : null}
        onClose={() => setActiveAction(null)}
      />
    </RecordStack>
  );
}

/** The supply: what is issued, the cap and what it leaves, who mints; mint, burn and lock beside them. */
function SupplyBlock({
  token,
  ops,
  rows,
}: Pick<TokenTabProps, "token" | "ops"> & { rows: OperationRow[] | null }) {
  const t = useTranslations();
  const locale = useLocale();
  const decimals = Math.min(Math.max(token.decimals, 2), 9);
  const leftFormat = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: decimals,
      }),
    [locale, decimals]
  );
  const issued = Number(token.totalSupply || 0);
  const cap = token.maxSupply ? Number(token.maxSupply) : null;
  const left = cap !== null && Number.isFinite(cap) ? Math.max(0, cap - issued) : null;
  // Mint or burn opens in place under the issued supply, its own button giving way to the form.
  const openAction = rows ? ops.fundManagementModalAction : null;
  // Lock supply opens the same way under the cap.
  const lockOpen = Boolean(rows) && ops.lockSupplyModalOpen && ops.lockSupplyRemaining !== null;
  const actions = (ids: ReadonlySet<string>) => (
    <OperationButtons
      rows={
        rows?.filter(
          (row) => ids.has(row.id) && row.id !== openAction && !(lockOpen && row.id === LOCK_SUPPLY)
        ) ?? []
      }
      pending={ops.isPending}
    />
  );

  return (
    <RecordBlock title={t("DashboardIssuance.newDesign.operations.supply")} className="gap-6">
      <dl>
        <OperationLine
          label={t("DashboardIssuance.newDesign.overview.issuedSupply")}
          actions={actions(ISSUED_SUPPLY_OPERATIONS)}
          open={
            openAction ? <SupplyOperationForm token={token} ops={ops} action={openAction} /> : null
          }
        >
          <span>{formatDecimalAmount(token.totalSupply || "0", locale)}</span>
          <span className="rounded-control bg-fill-subtle px-1.5 text-meta text-secondary">
            {token.symbol}
          </span>
        </OperationLine>
        <OperationLine
          label={t("DashboardIssuance.newDesign.overview.supplyCap")}
          hint={t("DashboardIssuance.newDesign.operations.supplyCapHint")}
          actions={actions(SUPPLY_CAP_OPERATIONS)}
          open={lockOpen ? <LockSupplyForm ops={ops} /> : null}
        >
          {cap === null
            ? t("DashboardIssuance.newDesign.overview.noCap")
            : t("DashboardIssuance.newDesign.operations.capLeft", {
                cap: formatDecimalAmount(token.maxSupply ?? "0", locale),
                left: leftFormat.format(left ?? 0),
              })}
        </OperationLine>
        <OperationLine
          label={t("DashboardIssuance.newDesign.operations.mintAuthority")}
          hint={t("DashboardIssuance.newDesign.permissions.mintWhy")}
        >
          {holderName(token.mintAuthority, ops.authorityWallets, t)}
        </OperationLine>
      </dl>
    </RecordBlock>
  );
}

const ACCESS_CONTROL_WHY: Record<"allowlist" | "blocklist" | "disabled", MessageKey> = {
  allowlist: "DashboardIssuance.newDesign.permissions.allowlistWhy",
  blocklist: "DashboardIssuance.newDesign.permissions.blocklistWhy",
  disabled: "DashboardIssuance.newDesign.permissions.noListWhy",
};

/**
 * Transfers: whether they run, who freezes and who may hold; pause, freeze and the list beside
 * them. Pause and freeze open in place under their rows; the list opens Compliance.
 */
function TransfersBlock({
  token,
  ops,
  state,
  onChain,
  rows,
}: Pick<TokenTabProps, "token" | "ops" | "state"> & {
  onChain: boolean;
  rows: OperationRow[] | null;
}) {
  const t = useTranslations();
  // Pause and freeze open in place under their rows, the row's button giving way to the form.
  const [open, setOpen] = useState<typeof PAUSE | typeof FREEZE | null>(null);
  const paused = state === "paused";
  const running = onChain
    ? t("DashboardIssuance.newDesign.operations.transfersRunning")
    : t("DashboardIssuance.newDesign.publicInfo.notDeployed");
  const actions = (id: string) => (
    <OperationButtons
      rows={
        rows
          ?.filter((row) => row.id === id && row.id !== open)
          .map((row) =>
            row.id === PAUSE || row.id === FREEZE
              ? {
                  ...row,
                  onAction: () => {
                    // Demo mode opens the freeze filled in, as the dialogs it replaced did.
                    if (row.id === FREEZE) ops.prefillDemoOperation("freeze");
                    setOpen(row.id === PAUSE ? PAUSE : FREEZE);
                  },
                }
              : row
          ) ?? []
      }
      pending={ops.isPending}
      paused={paused}
    />
  );
  const close = () => setOpen(null);

  return (
    <RecordBlock title={t("DashboardIssuance.newDesign.operations.transfers")} className="gap-6">
      <dl>
        <OperationLine
          label={t("DashboardIssuance.newDesign.operations.transfers")}
          actions={actions(PAUSE)}
          open={
            rows && open === PAUSE ? (
              <PauseTransfersForm ops={ops} paused={paused} onClose={close} />
            ) : null
          }
        >
          {paused ? t("DashboardIssuance.newDesign.operations.transfersPaused") : running}
        </OperationLine>
        {token.isFreezable ? (
          <OperationLine
            label={t("DashboardIssuance.newDesign.operations.freezeAuthority")}
            hint={t("DashboardIssuance.newDesign.permissions.freezeWhy")}
            actions={actions(FREEZE)}
            open={rows && open === FREEZE ? <FreezeAccountForm ops={ops} onClose={close} /> : null}
          >
            {holderName(token.freezeAuthority, ops.authorityWallets, t)}
          </OperationLine>
        ) : null}
        <OperationLine
          label={t("DashboardIssuance.newDesign.overview.accessControl")}
          hint={t(ACCESS_CONTROL_WHY[ops.accessControlMode])}
          actions={actions("allowlist")}
        >
          {accessControlLabel(ops.accessControlMode, t)}
        </OperationLine>
      </dl>
    </RecordBlock>
  );
}

/**
 * One fact as Operations lays it out: its label (and why it matters), its value, and the
 * operations that change it at the row's end. Every row is 51px, with or without a button.
 */
function OperationLine({
  label,
  hint,
  actions,
  open,
  children,
}: {
  label: string;
  hint?: string;
  actions?: ReactNode;
  /** An operation opened in place under the row (mint, burn, lock, pause or freeze), across its full width. */
  open?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-12.5 grid-cols-1 items-center gap-x-6 gap-y-1.5 border-b border-border-subtle py-2.5 last:border-b-0 @xl:grid-cols-[10.5rem_minmax(0,1fr)_auto] @xl:gap-y-2">
      <dt className="flex items-center gap-1.5 text-nav text-secondary">
        {label}
        {hint ? <InfoHint text={hint} className="[&_svg]:size-3.5" /> : null}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-nav text-primary tabular-nums">
        {children}
      </dd>
      {/* Stacked on a phone, the buttons sit 14px under the value. */}
      {actions ? (
        <dd className="mt-2 flex items-center gap-2 empty:hidden @xl:mt-0">{actions}</dd>
      ) : null}
      {open ? <dd className="col-span-full">{open}</dd> : null}
    </div>
  );
}

/** The design's 36px buttons on a phone, 30px once a row lays out across. */
const OPERATION_BUTTON_HEIGHT = "[--button-height-md:2.25rem] @xl:[--button-height-md:1.875rem]";

/**
 * The operations a row offers, as outline buttons; one that cannot run says why on hover.
 * The access list opens Compliance instead, as a link.
 */
function OperationButtons({
  rows,
  pending,
  paused = false,
}: {
  rows: OperationRow[];
  pending: boolean;
  paused?: boolean;
}) {
  const t = useTranslations();
  return rows.map(({ icon, ...row }) => {
    const copy = OPERATION_COPY[row.id === PAUSE && paused ? RESUME : row.id];
    const disabled = pending || Boolean(row.disabledReason);
    if (row.id === "allowlist") {
      return (
        <span key={row.id} data-token-operation={row.id} className="inline-flex">
          <Button
            variant="ghost"
            size="sm"
            className={cn("text-secondary hover:text-primary", OPERATION_BUTTON_HEIGHT)}
            onClick={row.onAction}
            iconRight={<ArrowUpRightIcon aria-hidden="true" />}
          >
            {t("DashboardIssuance.newDesign.operations.openCompliance")}
          </Button>
        </span>
      );
    }
    const Icon = OPERATION_ICON[row.id] ?? icon;
    return (
      <span key={row.id} data-token-operation={row.id} className="inline-flex">
        <TokenDisabledActionTooltip reason={pending ? null : (row.disabledReason ?? null)}>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "shrink-0",
              OPERATION_BUTTON_HEIGHT,
              DANGER_OPERATIONS.has(row.id) && "text-error refresh:border-error/40"
            )}
            disabled={disabled}
            onClick={row.onAction}
            iconLeft={<Icon aria-hidden="true" />}
          >
            {copy ? t(copy.action) : (row.actionLabel ?? row.title)}
          </Button>
        </TokenDisabledActionTooltip>
      </span>
    );
  });
}

/** Recovery operations, folded away until asked for. */
function RecoveryFold({ rows, pending }: { rows: OperationRow[]; pending: boolean }) {
  const t = useTranslations();
  return (
    <details className="group/recovery">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-subheading font-medium text-primary [&::-webkit-details-marker]:hidden">
        {t("DashboardIssuance.newDesign.operations.recovery")}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 text-secondary transition-transform group-open/recovery:rotate-180"
        />
      </summary>
      <div className="mt-5">
        <OperationRows rows={rows} pending={pending} />
      </div>
    </details>
  );
}

/** The chosen recovery operation's form in a modal; seize and force burn close it as they run. */
function OperationModal({
  token,
  ops,
  activeAction,
  label,
  onClose,
}: Pick<TokenTabProps, "token" | "ops"> & {
  activeAction: OperationAction | null;
  label: string | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <Modal
      isOpen={Boolean(activeAction)}
      ariaLabel={label ?? t("DashboardIssuance.management.operations")}
      onClose={onClose}
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
              onClose();
              ops.handleSeize();
            },
            handleForceBurn: () => {
              onClose();
              ops.handleForceBurn();
            },
            handleFreeze: (freeze) => {
              onClose();
              ops.handleFreeze(freeze);
            },
          }}
          formVariant="bare"
          submitAlignment="end"
        />
      ) : null}
    </Modal>
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
                "shrink-0",
                OPERATION_BUTTON_HEIGHT,
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
        <TokenTable
          tableClassName="min-w-[560px]"
          columns={[
            { className: "w-[20%]", label: t("DashboardIssuance.newDesign.operations.type") },
            { className: "w-[20%]", label: t("DashboardIssuance.newDesign.operations.status") },
            { className: "w-[34%]", label: t("DashboardIssuance.newDesign.operations.signature") },
            { className: "w-[26%]", label: t("DashboardIssuance.newDesign.operations.created") },
          ]}
        >
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
                    <ArrowUpRightIcon className="size-3" aria-hidden="true" />
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
        </TokenTable>
      )}
      {pageCount > 1 ? (
        <ArrowPagination page={page} pageCount={pageCount} onPageChange={setPage} />
      ) : null}
    </RecordBlock>
  );
}
