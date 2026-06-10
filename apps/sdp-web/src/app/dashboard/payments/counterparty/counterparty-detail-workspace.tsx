"use client";

import type {
  Counterparty,
  CounterpartyAccount,
  PaymentTransferSummary,
  RampProviderId,
} from "@sdp/types";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CakeIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FlagIcon,
  GlobeIcon,
  HashIcon,
  IdCardIcon,
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
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { toTitleCase } from "../../activity-format-utils";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
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
        tone === "success" && "bg-status-success-bg text-status-success-text",
        tone === "error" && "bg-status-error-bg text-status-error-text",
        tone === "pending" && "bg-border-light text-text-medium"
      )}
    >
      {toTitleCase(status)}
    </span>
  );
}

function TransferProviderCell({ provider }: { provider?: RampProviderId }) {
  if (!provider) {
    return <span className="text-sm text-text-low">—</span>;
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
      <span className="text-sm text-text-extra-high">{getRampProviderLabel(provider)}</span>
    </div>
  );
}

function TransferTableRow({ transfer }: { transfer: PaymentTransferSummary }) {
  const isInbound = transfer.type === "onramp" || transfer.direction === "inbound";
  const walletAddress = isInbound ? transfer.destination : transfer.source;
  const cryptoLabel =
    transfer.amount && transfer.token ? formatDisplayAmount(transfer.amount, transfer.token) : null;
  const fiatLabel =
    transfer.fiatAmount && transfer.fiatCurrency
      ? `${transfer.fiatAmount} ${transfer.fiatCurrency.toUpperCase()}`
      : null;
  const typeLabel = transfer.type ? toTitleCase(transfer.type) : "Transfer";

  return (
    <tr className="border-b border-border-light last:border-b-0">
      <td className="whitespace-nowrap px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-border-light text-text-medium [&_svg]:size-4">
            {isInbound ? <ArrowDownLeftIcon /> : <ArrowUpRightIcon />}
          </span>
          <span className="text-sm font-medium text-text-extra-high">{typeLabel}</span>
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <TransferProviderCell provider={transfer.provider} />
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        {walletAddress ? (
          <span className="font-mono text-xs text-text-medium" title={walletAddress}>
            {shortenAddress(walletAddress)}
          </span>
        ) : (
          <span className="text-sm text-text-low">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <span className="text-sm font-medium text-text-extra-high">{cryptoLabel ?? "—"}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <span className="text-sm text-text-medium">{fiatLabel ?? "—"}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <TransferStatusBadge status={transfer.status} />
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-text-low">
        {formatTimestamp(transfer.createdAt)}
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
          ? "border-gray-1400 bg-gray-1400 text-white"
          : "border-border-light bg-white text-text-medium hover:text-text-extra-high"
      )}
    >
      {children}
    </button>
  );
}

const TRANSFER_TABLE_HEADERS = [
  { label: "Transaction", align: "left" as const, width: "24%" },
  { label: "Provider", align: "left" as const, width: "16%" },
  { label: "Wallet", align: "left" as const, width: "16%" },
  { label: "Amount", align: "right" as const, width: "14%" },
  { label: "Fiat", align: "right" as const, width: "12%" },
  { label: "Status", align: "left" as const, width: "10%" },
  { label: "Date", align: "right" as const, width: "8%" },
];

function CounterpartyTransactions({ transfers }: { transfers: PaymentTransferSummary[] }) {
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<RampProviderId | null>(null);

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
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-medium py-10 text-center">
          <ReceiptTextIcon className="size-7 text-text-extra-low" />
          <p className="text-sm text-text-low">No transactions tied to this counterparty yet.</p>
        </div>
      ) : (
        <>
          {showFilters ? (
            <div className="flex flex-wrap items-center gap-2">
              {availableTypes.length > 1 ? (
                <>
                  <FilterChip active={typeFilter === null} onClick={() => setTypeFilter(null)}>
                    All types
                  </FilterChip>
                  {availableTypes.map((type) => (
                    <FilterChip
                      key={type}
                      active={typeFilter === type}
                      onClick={() => setTypeFilter(type)}
                    >
                      {toTitleCase(type)}
                    </FilterChip>
                  ))}
                </>
              ) : null}
              {availableProviders.length > 1 ? (
                <>
                  <span className="mx-1 h-4 w-px bg-border-light" />
                  <FilterChip
                    active={providerFilter === null}
                    onClick={() => setProviderFilter(null)}
                  >
                    All providers
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

          <div className="overflow-x-auto rounded-2xl border border-border-light bg-white shadow-sm">
            <table className="w-full min-w-[720px] table-fixed border-collapse">
              <thead>
                <tr className="border-b border-border-light">
                  {TRANSFER_TABLE_HEADERS.map((header) => (
                    <th
                      key={header.label}
                      style={{ width: header.width }}
                      className={cn(
                        "px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-text-medium",
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
                      colSpan={TRANSFER_TABLE_HEADERS.length}
                      className="px-4 py-8 text-center text-sm text-text-low"
                    >
                      No transactions match the selected filters.
                    </td>
                  </tr>
                ) : (
                  filteredTransfers.map((transfer) => (
                    <TransferTableRow key={transfer.id} transfer={transfer} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

type InfoRowData = { label: string; value: string; icon: ReactNode; mono?: boolean };

function FieldList({ rows }: { rows: InfoRowData[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-flow-col sm:grid-rows-3">
      {rows.map((row) => (
        <div key={row.label} className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-border-light text-text-medium [&_svg]:size-4">
            {row.icon}
          </span>
          <div className="min-w-0 space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-text-medium">
              {row.label}
            </dt>
            <dd
              className={cn(
                "truncate text-sm text-text-extra-high",
                row.mono && "font-mono text-xs"
              )}
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

function buildPersonalInfoRows(counterparty: Counterparty): InfoRowData[] {
  const identity = counterparty.identity ?? {};
  const rows: InfoRowData[] = [];

  const fullName = [
    identity.firstName,
    identity.middleName,
    identity.lastName,
    identity.secondLastName,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  if (fullName) rows.push({ label: "Full name", value: fullName, icon: <UserIcon /> });
  if (identity.dateOfBirth) {
    rows.push({ label: "Date of birth", value: identity.dateOfBirth, icon: <CakeIcon /> });
  }
  if (identity.phone) rows.push({ label: "Phone", value: identity.phone, icon: <PhoneIcon /> });

  const address = identity.address;
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
    if (formatted) rows.push({ label: "Address", value: formatted, icon: <MapPinIcon /> });
  }

  if (identity.birthCountryCode) {
    rows.push({ label: "Birth country", value: identity.birthCountryCode, icon: <GlobeIcon /> });
  }
  if (identity.citizenshipCountryCode) {
    rows.push({ label: "Citizenship", value: identity.citizenshipCountryCode, icon: <FlagIcon /> });
  }
  if (identity.governmentId) {
    rows.push({
      label: "Government ID",
      value: `${identity.governmentId.type} · ${identity.governmentId.number}`,
      icon: <IdCardIcon />,
      mono: true,
    });
  }

  return rows;
}

export function CounterpartyDetailWorkspace({
  counterparty,
  initialAccounts,
  initialTransfers,
}: CounterpartyDetailWorkspaceProps) {
  const router = useRouter();
  const { copy, copied } = useCopy(1200);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "transactions">("details");
  const personalInfoRows = buildPersonalInfoRows(counterparty);

  async function confirmDelete() {
    const result = await dashboardFetch(
      `/api/dashboard/counterparty/${encodeURIComponent(counterparty.id)}`,
      { method: "DELETE" }
    );
    if (!result.ok) {
      toast.error(result.error, { position: "bottom-right" });
      return;
    }
    toast.success(`${counterparty.displayName} deleted`, { position: "bottom-right" });
    router.push("/dashboard/payments/counterparty");
  }

  return (
    <DashboardWorkspaceOverviewPanel className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-3xl font-medium tracking-tight text-text-extra-high">
            {counterparty.displayName}
          </h2>
          <p className="text-sm text-text-medium">
            {toTitleCase(counterparty.entityType)} · Counterparty
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" iconRight={<ChevronDownIcon />}>
              Manage
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              className="text-status-error-text focus:text-status-error-text [&_svg]:size-4"
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2Icon />
              Delete counterparty
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex gap-6 border-b border-border-light">
        {(["details", "transactions"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={cn(
              "relative pb-3 text-sm font-medium transition-colors",
              activeTab === tab
                ? "text-text-extra-high"
                : "text-text-medium hover:text-text-extra-high"
            )}
          >
            {tab === "details" ? "Details" : "Transactions"}
            {activeTab === tab ? (
              <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-gray-1400" />
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === "transactions" ? (
        <CounterpartyTransactions transfers={initialTransfers} />
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="space-y-3">
              <h3 className="text-2xl font-medium text-text-extra-high">Identity</h3>
              <div className="rounded-2xl border border-border-light bg-white p-5 shadow-sm">
                <FieldList
                  rows={[
                    { label: "Display name", value: counterparty.displayName, icon: <UserIcon /> },
                    {
                      label: "Type",
                      value: toTitleCase(counterparty.entityType),
                      icon: <UsersIcon />,
                    },
                    { label: "Email", value: counterparty.email, icon: <MailIcon /> },
                    {
                      label: "External ID",
                      value: counterparty.externalId ?? "—",
                      icon: <HashIcon />,
                    },
                    {
                      label: "Status",
                      value: toTitleCase(counterparty.status),
                      icon: <ShieldCheckIcon />,
                    },
                    {
                      label: "Created",
                      value: new Date(counterparty.createdAt).toLocaleDateString("en-US", {
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
              <h3 className="text-2xl font-medium text-text-extra-high">Personal information</h3>
              <div className="rounded-2xl border border-border-light bg-white p-5 shadow-sm">
                {personalInfoRows.length > 0 ? (
                  <FieldList rows={personalInfoRows} />
                ) : (
                  <p className="text-sm text-text-low">No personal information on file.</p>
                )}
              </div>
            </section>
          </div>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-medium text-text-extra-high">External accounts</h3>
              <Button
                type="button"
                size="sm"
                iconLeft={<PlusIcon />}
                onClick={() => setAddOpen(true)}
              >
                Add External Account
              </Button>
            </div>
            {accounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-medium py-10 text-center">
                <WalletIcon className="size-7 text-text-extra-low" />
                <p className="text-sm text-text-low">No external accounts yet.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border-light bg-white shadow-sm">
                {accounts.map((account) => {
                  const details = account.details as { network?: string; address?: string };
                  return (
                    <div
                      key={account.id}
                      className="flex items-center justify-between gap-4 border-b border-border-light px-4 py-3 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-extra-high">
                          {account.label ?? "Crypto wallet"}
                        </p>
                        <div className="flex items-center gap-1.5">
                          <p className="truncate font-mono text-xs text-text-medium">
                            {details.address}
                          </p>
                          {details.address && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Copy address"
                              onClick={() => {
                                if (!details.address) return;
                                setCopiedId(account.id);
                                void copy(details.address);
                                toast.success("Address copied", { position: "bottom-right" });
                              }}
                            >
                              {copied && copiedId === account.id ? (
                                <CheckIcon className="text-status-success-text" />
                              ) : (
                                <CopyIcon />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-text-medium">{details.network}</span>
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
