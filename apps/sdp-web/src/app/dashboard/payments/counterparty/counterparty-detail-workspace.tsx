"use client";

import type {
  Counterparty,
  CounterpartyAccount,
  PaymentTransferSummary,
  RampProviderId,
  RampTransferSettlement,
} from "@sdp/types";
import {
  ArrowRightIcon,
  BanknoteArrowDownIcon,
  BanknoteArrowUpIcon,
  CakeIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  HashIcon,
  MailIcon,
  MapPinIcon,
  PhoneIcon,
  PlusIcon,
  ReceiptTextIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { formatRelativeTime, toTitleCase } from "../../activity-format-utils";
import {
  formatDisplayAmount,
  formatMinorCurrencyAmount,
  formatTimestamp,
  resolveTransferFlow,
  resolveTransferTypeLabel,
  shortenAddress,
} from "../payments-overview.utils";
import { getDevnetExplorerUrl } from "../payments-workspace.data";
import { AddExternalAccountDialog } from "./add-external-account-dialog";
import { DeleteCounterpartyDialog } from "./delete-counterparty-dialog";

interface CounterpartyDetailWorkspaceProps {
  counterparty: Counterparty;
  initialAccounts: CounterpartyAccount[];
  initialTransfers: PaymentTransferSummary[];
}

const TRANSFER_STATUS_TONE = {
  completed: "success",
  confirmed: "success",
  finalized: "success",
  failed: "error",
  expired: "error",
  pending: "pending",
  processing: "pending",
  awaiting_payment: "pending",
  settling: "pending",
} as const satisfies Record<string, "success" | "error" | "pending">;

function resolveTransferStatusTone(status: string): "success" | "error" | "pending" {
  if (status in TRANSFER_STATUS_TONE) {
    return TRANSFER_STATUS_TONE[status as keyof typeof TRANSFER_STATUS_TONE];
  }
  return "pending";
}

function TransferStatusBadge({ status }: { status: string }) {
  const tone = resolveTransferStatusTone(status);
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "success" && "bg-success-bg text-success",
        tone === "error" && "bg-error-bg text-error",
        tone === "pending" && "bg-fill-strong text-secondary"
      )}
    >
      {toTitleCase(status)}
    </span>
  );
}

function TransferProviderCell({ provider }: { provider?: RampProviderId }) {
  if (!provider) {
    return <span className="text-sm text-tertiary">—</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <Image
        src={RAMP_PROVIDER_LOGOS[provider]}
        alt=""
        width={20}
        height={20}
        className="size-5 rounded"
      />
      <span className="text-sm text-primary">{getRampProviderLabel(provider)}</span>
    </div>
  );
}

function TransferTableRow({
  transfer,
  onSelect,
}: {
  transfer: PaymentTransferSummary;
  onSelect: (transfer: PaymentTransferSummary) => void;
}) {
  const t = useTranslations();
  const isInbound = transfer.type === "onramp" || transfer.direction === "inbound";
  const walletAddress = isInbound ? transfer.destination : transfer.source;
  const flow = resolveTransferFlow(transfer);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a table row can't be a <button>; role+key handler is the accessible compromise
    <tr
      role="button"
      tabIndex={0}
      onClick={() => onSelect(transfer)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(transfer);
        }
      }}
      className="cursor-pointer border-b border-border-default transition-colors last:border-b-0 hover:bg-fill-subtle"
    >
      <td className="whitespace-nowrap px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-strong text-secondary [&_svg]:size-4">
            {isInbound ? <BanknoteArrowDownIcon /> : <BanknoteArrowUpIcon />}
          </span>
          <span className="text-sm font-medium text-primary">
            {resolveTransferTypeLabel(transfer.type, t)}
          </span>
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <TransferProviderCell provider={transfer.provider} />
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        {walletAddress ? (
          <span className="font-mono text-xs text-secondary" title={walletAddress}>
            {shortenAddress(walletAddress)}
          </span>
        ) : (
          <span className="text-sm text-tertiary">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        {flow.send || flow.receive ? (
          <span className="inline-flex items-center justify-end gap-1.5 text-sm">
            {flow.send ? <span className="text-secondary">{flow.send}</span> : null}
            {flow.send && flow.receive ? (
              <ArrowRightIcon className="size-3.5 text-tertiary" />
            ) : null}
            {flow.receive ? <span className="font-medium text-primary">{flow.receive}</span> : null}
          </span>
        ) : (
          <span className="text-sm text-tertiary">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <TransferStatusBadge status={transfer.status} />
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-tertiary">
        {transfer.createdAt ? (
          <span title={formatTimestamp(transfer.createdAt, t)}>
            {formatRelativeTime(transfer.createdAt)}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-on-primary"
          : "border-border-default bg-surface-raised text-secondary hover:text-primary"
      )}
    >
      {children}
    </button>
  );
}

function CounterpartyTransactions({
  transfers,
  counterpartyName,
}: {
  transfers: PaymentTransferSummary[];
  counterpartyName: string;
}) {
  const t = useTranslations();
  const transferTableHeaders = [
    {
      label: t("DashboardPayments.counterparty.transferType"),
      align: "left" as const,
      width: "12%",
    },
    {
      label: t("DashboardPayments.counterparty.transferProvider"),
      align: "left" as const,
      width: "16%",
    },
    {
      label: t("DashboardPayments.counterparty.transferWallet"),
      align: "left" as const,
      width: "15%",
    },
    {
      label: t("DashboardPayments.counterparty.transferAmount"),
      align: "right" as const,
      width: "28%",
    },
    {
      label: t("DashboardPayments.counterparty.transferStatus"),
      align: "left" as const,
      width: "13%",
    },
    {
      label: t("DashboardPayments.counterparty.transferDate"),
      align: "right" as const,
      width: "16%",
    },
  ];
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<RampProviderId | null>(null);
  const [selectedTransfer, setSelectedTransfer] = useState<PaymentTransferSummary | null>(null);

  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    for (const transfer of transfers) {
      if (transfer.type) {
        types.add(transfer.type);
      }
    }
    return [...types];
  }, [transfers]);

  const availableProviders = useMemo(() => {
    const providers = new Set<RampProviderId>();
    for (const transfer of transfers) {
      if (transfer.provider) {
        providers.add(transfer.provider);
      }
    }
    return [...providers];
  }, [transfers]);

  const filteredTransfers = useMemo(
    () =>
      transfers.filter((transfer) => {
        if (typeFilter && transfer.type !== typeFilter) {
          return false;
        }
        if (providerFilter && transfer.provider !== providerFilter) {
          return false;
        }
        return true;
      }),
    [transfers, typeFilter, providerFilter]
  );

  const showFilters = availableTypes.length > 1 || availableProviders.length > 1;

  return (
    <section className="space-y-3">
      {transfers.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong py-10 text-center">
          <ReceiptTextIcon className="size-7 text-muted" />
          <p className="text-sm text-tertiary">
            {t("DashboardPayments.counterparty.noTransactions")}
          </p>
        </div>
      ) : (
        <>
          {showFilters ? (
            <div className="flex flex-wrap items-center gap-2">
              {availableTypes.length > 1 ? (
                <>
                  <FilterChip active={typeFilter === null} onClick={() => setTypeFilter(null)}>
                    {t("DashboardPayments.counterparty.allTypes")}
                  </FilterChip>
                  {availableTypes.map((type) => (
                    <FilterChip
                      key={type}
                      active={typeFilter === type}
                      onClick={() => setTypeFilter(type)}
                    >
                      {resolveTransferTypeLabel(type, t)}
                    </FilterChip>
                  ))}
                </>
              ) : null}
              {availableProviders.length > 1 ? (
                <>
                  <span className="mx-1 h-4 w-px bg-fill-strong" />
                  <FilterChip
                    active={providerFilter === null}
                    onClick={() => setProviderFilter(null)}
                  >
                    {t("DashboardPayments.counterparty.allProviders")}
                  </FilterChip>
                  {availableProviders.map((provider) => (
                    <FilterChip
                      key={provider}
                      active={providerFilter === provider}
                      onClick={() => setProviderFilter(provider)}
                    >
                      {getRampProviderLabel(provider)}
                    </FilterChip>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-2xl border border-border-default bg-surface-raised shadow-sm">
            <table className="w-full min-w-[760px] table-fixed border-collapse">
              <thead>
                <tr className="border-b border-border-default">
                  {transferTableHeaders.map((header) => (
                    <th
                      key={header.label}
                      style={{ width: header.width }}
                      className={cn(
                        "px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-secondary",
                        header.align === "right" ? "text-right" : "text-left"
                      )}
                    >
                      {header.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredTransfers.length === 0 ? (
                  <tr>
                    <td
                      colSpan={transferTableHeaders.length}
                      className="px-4 py-8 text-center text-sm text-tertiary"
                    >
                      {t("DashboardPayments.counterparty.noFilteredTransactions")}
                    </td>
                  </tr>
                ) : (
                  filteredTransfers.map((transfer) => (
                    <TransferTableRow
                      key={transfer.id}
                      transfer={transfer}
                      onSelect={setSelectedTransfer}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <TransferDetailModal
        transfer={selectedTransfer}
        counterpartyName={counterpartyName}
        onClose={() => setSelectedTransfer(null)}
      />
    </section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations();
  const { copy, copied } = useCopy(1200);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      onClick={() => {
        void copy(value);
        toast.success(t("Shared.SharedComponents.copied"), { position: "bottom-right" });
      }}
    >
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
    </Button>
  );
}

function DetailRow({
  label,
  value,
  mono,
  copyValue,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  copyValue?: string;
}) {
  const t = useTranslations();
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="shrink-0 text-sm text-tertiary">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn("truncate text-sm text-primary", mono && "font-mono text-xs")}>
          {value}
        </span>
        {copyValue ? (
          <CopyButton
            value={copyValue}
            label={t("DashboardPayments.transferDetails.copy", { label })}
          />
        ) : null}
      </div>
    </div>
  );
}

function RampSettlementRows({ settlement }: { settlement: RampTransferSettlement }) {
  const t = useTranslations();
  if (settlement.provider === "moonpay") {
    const rate =
      settlement.quoteCurrencyAmount > 0
        ? settlement.baseCurrencyAmount / settlement.quoteCurrencyAmount
        : null;
    return (
      <>
        <DetailRow
          label={t("DashboardPayments.transferDetails.providerFee")}
          value={formatDisplayAmount(String(settlement.feeAmount), settlement.baseCurrencyCode)}
        />
        {settlement.networkFeeAmount > 0 ? (
          <DetailRow
            label={t("DashboardPayments.transferDetails.networkFee")}
            value={formatDisplayAmount(
              String(settlement.networkFeeAmount),
              settlement.baseCurrencyCode
            )}
          />
        ) : null}
        {rate !== null ? (
          <DetailRow
            label={t("DashboardPayments.transferDetails.exchangeRate")}
            value={`1 ${settlement.quoteCurrencyCode} = ${formatDisplayAmount(rate.toFixed(2), settlement.baseCurrencyCode)}`}
          />
        ) : null}
      </>
    );
  }

  const sentDecimal = settlement.sentAmount.amount / 10 ** settlement.sentAmount.decimals;
  const receivedDecimal =
    settlement.receivedAmount.amount / 10 ** settlement.receivedAmount.decimals;
  const rate = receivedDecimal > 0 ? sentDecimal / receivedDecimal : null;
  const fees = formatMinorCurrencyAmount(
    settlement.fees,
    settlement.sentAmount.currencyCode,
    settlement.sentAmount.decimals
  );
  return (
    <>
      {fees ? <DetailRow label={t("DashboardPayments.transferDetails.fees")} value={fees} /> : null}
      {rate !== null ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.exchangeRate")}
          value={`1 ${settlement.receivedAmount.currencyCode} = ${rate.toFixed(4)} ${settlement.sentAmount.currencyCode}`}
        />
      ) : null}
    </>
  );
}

function TransferDetailModal({
  transfer,
  counterpartyName,
  onClose,
}: {
  transfer: PaymentTransferSummary | null;
  counterpartyName: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  if (!transfer) {
    return null;
  }

  const isInbound = transfer.type === "onramp" || transfer.direction === "inbound";
  const walletAddress = isInbound ? transfer.destination : transfer.source;
  const moneygram = transfer.moneygram;
  const signature = transfer.signature ?? moneygram?.solanaTxSignature ?? null;
  const flow = resolveTransferFlow(transfer);
  const counterpartyParty = transfer.fiatCurrency
    ? `${counterpartyName} · ${transfer.fiatCurrency.toUpperCase()}`
    : counterpartyName;

  const walletRow = walletAddress ? (
    <DetailRow
      label={isInbound ? t("DashboardPayments.requests.to") : t("DashboardPayments.requests.from")}
      value={shortenAddress(walletAddress)}
      mono
      copyValue={walletAddress}
    />
  ) : null;
  const counterpartyRow = (
    <DetailRow
      label={isInbound ? t("DashboardPayments.requests.from") : t("DashboardPayments.requests.to")}
      value={counterpartyParty}
    />
  );

  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardPayments.counterparty.transactionDetails")}
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4 pr-8">
          <div className="space-y-1">
            <h2 className="text-xl font-medium tracking-tight text-primary">
              {resolveTransferTypeLabel(transfer.type, t)}
            </h2>
            {transfer.createdAt ? (
              <p className="text-sm text-secondary">{formatTimestamp(transfer.createdAt, t)}</p>
            ) : null}
          </div>
          <TransferStatusBadge status={transfer.status} />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-2xl bg-fill-subtle p-5">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-medium uppercase tracking-wide text-secondary">
              {isInbound
                ? t("DashboardPayments.counterparty.youDeposit")
                : t("DashboardPayments.counterparty.youSend")}
            </p>
            <p className="truncate text-xl font-semibold tracking-tight text-primary">
              {flow.send ?? "—"}
            </p>
          </div>
          <ArrowRightIcon className="size-5 shrink-0 text-tertiary" />
          <div className="min-w-0 space-y-0.5 text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-secondary">
              {t("DashboardPayments.counterparty.recipientGets")}
            </p>
            <p className="truncate text-xl font-semibold tracking-tight text-primary">
              {flow.receive ?? "—"}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-border-default px-4">
          <div className="divide-y divide-border-default">
            {isInbound ? (
              <>
                {walletRow}
                {counterpartyRow}
              </>
            ) : (
              <>
                {counterpartyRow}
                {walletRow}
              </>
            )}
            {transfer.provider ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.provider")}
                value={<TransferProviderCell provider={transfer.provider} />}
              />
            ) : null}
            <DetailRow
              label={t("DashboardPayments.transferDetails.transactionId")}
              value={transfer.id}
              mono
              copyValue={transfer.id}
            />
            {transfer.providerReference ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.providerReference")}
                value={transfer.providerReference}
                mono
                copyValue={transfer.providerReference}
              />
            ) : null}
            {transfer.memo ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.memo")}
                value={transfer.memo}
              />
            ) : null}
            {transfer.settlement ? <RampSettlementRows settlement={transfer.settlement} /> : null}
            {moneygram?.referenceNumber ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.cashPickupCode")}
                value={moneygram.referenceNumber}
                mono
                copyValue={moneygram.referenceNumber}
              />
            ) : null}
            {moneygram?.transactionId ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.moneygramTransactionId")}
                value={moneygram.transactionId}
                mono
                copyValue={moneygram.transactionId}
              />
            ) : null}
            {moneygram?.payoutStatus ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.payoutStatus")}
                value={toTitleCase(moneygram.payoutStatus)}
              />
            ) : null}
            {moneygram?.payoutAmount !== undefined && transfer.fiatCurrency ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.payoutAmount")}
                value={formatDisplayAmount(String(moneygram.payoutAmount), transfer.fiatCurrency)}
              />
            ) : null}
            {moneygram?.cryptoTransferId ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.cryptoTransferId")}
                value={moneygram.cryptoTransferId}
                mono
                copyValue={moneygram.cryptoTransferId}
              />
            ) : null}
            {moneygram?.solanaTxSignature ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.solanaSignature")}
                value={shortenAddress(moneygram.solanaTxSignature)}
                mono
                copyValue={moneygram.solanaTxSignature}
              />
            ) : null}
            {moneygram?.lastWidgetError ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.moneygramError")}
                value={moneygram.lastWidgetError}
              />
            ) : null}
            {transfer.updatedAt ? (
              <DetailRow
                label={t("DashboardPayments.transferDetails.lastUpdated")}
                value={formatTimestamp(transfer.updatedAt, t)}
              />
            ) : null}
          </div>
        </div>

        {signature ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            iconLeft={<ExternalLinkIcon className="size-4" />}
            onClick={() =>
              window.open(getDevnetExplorerUrl(signature), "_blank", "noopener,noreferrer")
            }
          >
            {t("DashboardPayments.counterparty.viewOnExplorer")}
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}

type InfoRowData = { label: string; value: string; icon: ReactNode; mono?: boolean };

function FieldList({ rows }: { rows: InfoRowData[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-flow-col sm:grid-rows-3">
      {rows.map((row) => (
        <div key={row.label} className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-strong text-secondary [&_svg]:size-4">
            {row.icon}
          </span>
          <div className="min-w-0 space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-secondary">
              {row.label}
            </dt>
            <dd
              className={cn("truncate text-sm text-primary", row.mono && "font-mono text-xs")}
              title={row.value}
            >
              {row.value}
            </dd>
          </div>
        </div>
      ))}
    </dl>
  );
}

function buildPersonalInfoRows(
  counterparty: Counterparty,
  t: ReturnType<typeof useTranslations>
): InfoRowData[] {
  const rows: InfoRowData[] = [];

  if (counterparty.entityType === "individual") {
    const identity = counterparty.identity;
    const fullName = [
      identity.firstName,
      identity.middleName,
      identity.lastName,
      identity.secondLastName,
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(" ");
    if (fullName)
      rows.push({
        label: t("DashboardPayments.counterparty.fullName"),
        value: fullName,
        icon: <UserIcon />,
      });
    rows.push({
      label: t("DashboardPayments.counterparty.dateOfBirth"),
      value: identity.dateOfBirth,
      icon: <CakeIcon />,
    });
    rows.push({
      label: t("DashboardPayments.counterparty.phone"),
      value: identity.phone,
      icon: <PhoneIcon />,
    });
  }

  const address = counterparty.identity.address;
  if (address) {
    const formatted = [
      address.line1,
      address.line2,
      address.city,
      address.subdivisionCode,
      address.postalCode,
      address.countryCode,
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(", ");
    if (formatted)
      rows.push({
        label: t("DashboardPayments.counterparty.address"),
        value: formatted,
        icon: <MapPinIcon />,
      });
  }

  return rows;
}

export function CounterpartyDetailWorkspace({
  counterparty,
  initialAccounts,
  initialTransfers,
}: CounterpartyDetailWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { copy, copied } = useCopy(1200);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "transactions">("details");
  const personalInfoRows = buildPersonalInfoRows(counterparty, t);

  async function confirmDelete() {
    const result = await dashboardFetch(
      `/api/dashboard/counterparty/${encodeURIComponent(counterparty.id)}`,
      { method: "DELETE" }
    );
    if (!result.ok) {
      toast.error(result.error, { position: "bottom-right" });
      return;
    }
    toast.success(t("DashboardPayments.counterparty.deleted", { name: counterparty.displayName }), {
      position: "bottom-right",
    });
    router.push("/dashboard/payments/counterparty");
  }

  return (
    <DashboardWorkspaceOverviewPanel className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-3xl font-medium tracking-tight text-primary">
            {counterparty.displayName}
          </h2>
          <p className="text-sm text-secondary">
            {toTitleCase(counterparty.entityType)} · {t("DashboardPayments.counterpartyLabel")}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" iconRight={<ChevronDownIcon />}>
              {t("DashboardPayments.counterparty.manage")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              className="text-error focus:text-error [&_svg]:size-4"
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2Icon />
              {t("DashboardPayments.counterparty.deleteCounterparty")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex gap-6 border-b border-border-default">
        {(["details", "transactions"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={cn(
              "relative pb-3 text-sm font-medium transition-colors",
              activeTab === tab ? "text-primary" : "text-secondary hover:text-primary"
            )}
          >
            {tab === "details"
              ? t("DashboardPayments.counterparty.details")
              : t("DashboardPayments.counterparty.transactions")}
            {activeTab === tab ? (
              <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === "transactions" ? (
        <CounterpartyTransactions
          transfers={initialTransfers}
          counterpartyName={counterparty.displayName}
        />
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="space-y-3">
              <h3 className="text-2xl font-medium text-primary">
                {t("DashboardPayments.counterparty.identity")}
              </h3>
              <div className="rounded-2xl border border-border-default bg-surface-raised p-5 shadow-sm">
                <FieldList
                  rows={[
                    {
                      label: t("DashboardPayments.counterparty.displayName"),
                      value: counterparty.displayName,
                      icon: <UserIcon />,
                    },
                    {
                      label: t("DashboardPayments.counterparty.transferType"),
                      value: toTitleCase(counterparty.entityType),
                      icon: <UsersIcon />,
                    },
                    {
                      label: t("DashboardPayments.counterparty.email"),
                      value: counterparty.email,
                      icon: <MailIcon />,
                    },
                    {
                      label: t("DashboardPayments.counterparty.externalId"),
                      value: counterparty.externalId ?? "—",
                      icon: <HashIcon />,
                    },
                    {
                      label: t("DashboardPayments.counterparty.transferStatus"),
                      value: toTitleCase(counterparty.status),
                      icon: <ShieldCheckIcon />,
                    },
                    {
                      label: t("DashboardPayments.counterparty.createdLabel"),
                      value: new Date(counterparty.createdAt).toLocaleDateString(locale, {
                        month: "short",
                        day: "2-digit",
                        year: "numeric",
                      }),
                      icon: <CalendarIcon />,
                    },
                  ]}
                />
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-2xl font-medium text-primary">
                {t("DashboardPayments.counterparty.personalInformation")}
              </h3>
              <div className="rounded-2xl border border-border-default bg-surface-raised p-5 shadow-sm">
                {personalInfoRows.length > 0 ? (
                  <FieldList rows={personalInfoRows} />
                ) : (
                  <p className="text-sm text-tertiary">
                    {t("DashboardPayments.counterparty.noPersonalInformation")}
                  </p>
                )}
              </div>
            </section>
          </div>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-medium text-primary">
                {t("DashboardPayments.counterparty.externalAccounts")}
              </h3>
              <Button
                type="button"
                size="sm"
                iconLeft={<PlusIcon />}
                onClick={() => setAddOpen(true)}
              >
                {t("DashboardPayments.counterparty.addExternalAccountTitle")}
              </Button>
            </div>
            {accounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong py-10 text-center">
                <WalletIcon className="size-7 text-muted" />
                <p className="text-sm text-tertiary">
                  {t("DashboardPayments.counterparty.noExternalAccounts")}
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised shadow-sm">
                {accounts.map((account) => {
                  const details = account.details as { network?: string; address?: string };
                  return (
                    <div
                      key={account.id}
                      className="flex items-center justify-between gap-4 border-b border-border-default px-4 py-2.5 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-primary">
                          {account.label ?? t("DashboardPayments.counterparty.cryptoWallet")}
                        </p>
                        <div className="flex h-5 items-center gap-1">
                          <p className="truncate font-mono text-xs text-secondary">
                            {details.address}
                          </p>
                          {details.address && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="size-5"
                              aria-label={t("DashboardPayments.counterparty.copyAddress")}
                              onClick={() => {
                                if (!details.address) return;
                                setCopiedId(account.id);
                                void copy(details.address);
                                toast.success(t("DashboardPayments.counterparty.addressCopied"), {
                                  position: "bottom-right",
                                });
                              }}
                            >
                              {copied && copiedId === account.id ? (
                                <CheckIcon className="text-success" />
                              ) : (
                                <CopyIcon />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-secondary">
                        <Image
                          src="/landing/solana-logo.svg"
                          alt=""
                          width={16}
                          height={14}
                          className="h-3.5 w-auto"
                        />
                        Solana
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <AddExternalAccountDialog
        isOpen={addOpen}
        counterpartyId={counterparty.id}
        onAdded={(account) => setAccounts((prev) => [account, ...prev])}
        onClose={() => setAddOpen(false)}
      />

      <DeleteCounterpartyDialog
        isOpen={deleteOpen}
        displayName={counterparty.displayName}
        onConfirm={confirmDelete}
        onClose={() => setDeleteOpen(false)}
      />
    </DashboardWorkspaceOverviewPanel>
  );
}
