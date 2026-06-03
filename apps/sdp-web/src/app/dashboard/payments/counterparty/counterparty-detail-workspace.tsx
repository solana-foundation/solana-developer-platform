"use client";

import type { Counterparty, CounterpartyAccount } from "@sdp/types";
import {
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
  ShieldCheckIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";
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
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { toTitleCase } from "../../activity-format-utils";
import { AddExternalAccountDialog } from "./add-external-account-dialog";
import { DeleteCounterpartyDialog } from "./delete-counterparty-dialog";

interface CounterpartyDetailWorkspaceProps {
  counterparty: Counterparty;
  initialAccounts: CounterpartyAccount[];
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
}: CounterpartyDetailWorkspaceProps) {
  const router = useRouter();
  const { copy, copied } = useCopy(1200);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <h3 className="text-2xl font-medium text-text-extra-high">Identity</h3>
          <div className="rounded-2xl border border-border-light bg-white p-5 shadow-sm">
            <FieldList
              rows={[
                { label: "Display name", value: counterparty.displayName, icon: <UserIcon /> },
                { label: "Type", value: toTitleCase(counterparty.entityType), icon: <UsersIcon /> },
                { label: "Email", value: counterparty.email, icon: <MailIcon /> },
                { label: "External ID", value: counterparty.externalId ?? "—", icon: <HashIcon /> },
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
          <Button type="button" size="sm" iconLeft={<PlusIcon />} onClick={() => setAddOpen(true)}>
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
