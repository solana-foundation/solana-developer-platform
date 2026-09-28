"use client";

import type { Counterparty, CounterpartyAccount, PaymentTransferSummary } from "@sdp/types";
import {
  CalendarIcon,
  ChevronDownIcon,
  HashIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatCreatedDate } from "@/app/dashboard/custody/wallet-format-utils";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { useLocale, useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { cn } from "@/lib/utils";
import { toTitleCase } from "../../activity-format-utils";
import { AddExternalAccountDialog } from "./add-external-account-dialog";
import { CounterpartyProviderAccounts } from "./counterparty-provider-accounts";
import { CounterpartyTransactions } from "./counterparty-transactions";
import { DeleteCounterpartyDialog } from "./delete-counterparty-dialog";
import { useCounterpartyProviderAccounts } from "./use-counterparty-provider-accounts";

interface CounterpartyDetailWorkspaceProps {
  counterparty: Counterparty;
  initialAccounts: CounterpartyAccount[];
  initialTransfers: PaymentTransferSummary[];
}

const DETAIL_TABS = ["details", "transactions"] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

function FieldList({ rows }: { rows: { label: string; value: string; icon: ReactNode }[] }) {
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
            <dd className="truncate text-sm text-primary" title={row.value}>
              {row.value}
            </dd>
          </div>
        </div>
      ))}
    </dl>
  );
}

function ExternalAccountsList({ accounts }: { accounts: CounterpartyAccount[] }) {
  const t = useTranslations();
  if (accounts.length === 0) {
    return (
      <ListEmptyState
        className="min-h-0 rounded-lg border border-dashed border-border-strong py-10"
        icon={<WalletIcon className="size-5" />}
        message={t("DashboardPayments.counterparty.noExternalAccounts")}
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border-default bg-surface-raised">
      {accounts.map((account) => (
        <div
          key={account.id}
          className="flex items-center justify-between gap-4 border-b border-border-default px-4 py-2.5 last:border-b-0"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-primary">
              {account.label === null
                ? t("DashboardPayments.counterparty.cryptoWallet")
                : account.label}
            </p>
            <div className="flex h-5 items-center gap-1">
              <p className="truncate font-mono text-xs text-secondary">{account.details.address}</p>
              <WalletAddressCopyButton address={account.details.address} />
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
      ))}
    </div>
  );
}

export function CounterpartyDetailWorkspace({
  counterparty,
  initialAccounts,
  initialTransfers,
}: CounterpartyDetailWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const providerAccounts = useCounterpartyProviderAccounts(counterparty.id);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("details");

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
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto max-w-6xl space-y-6">
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
          {DETAIL_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "relative pb-3 text-sm font-medium transition-colors",
                activeTab === tab ? "text-primary" : "text-secondary hover:text-primary"
              )}
            >
              {t(`DashboardPayments.counterparty.${tab}`)}
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
            <section className="space-y-3">
              <h3 className="text-2xl font-medium text-primary">
                {t("DashboardPayments.counterparty.details")}
              </h3>
              <div className="rounded-lg border border-border-default bg-surface-raised p-5">
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
                      label: t("DashboardPayments.counterparty.externalId"),
                      value: counterparty.externalId === null ? "—" : counterparty.externalId,
                      icon: <HashIcon />,
                    },
                    {
                      label: t("DashboardPayments.counterparty.transferStatus"),
                      value: toTitleCase(counterparty.status),
                      icon: <ShieldCheckIcon />,
                    },
                    {
                      label: t("DashboardPayments.counterparty.createdLabel"),
                      value: formatCreatedDate(counterparty.createdAt, locale),
                      icon: <CalendarIcon />,
                    },
                  ]}
                />
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-2xl font-medium text-primary">
                {t("DashboardPayments.counterparty.providerAccounts")}
              </h3>
              <CounterpartyProviderAccounts
                accounts={providerAccounts.data}
                error={providerAccounts.error}
              />
            </section>

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
              <ExternalAccountsList accounts={accounts} />
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
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
