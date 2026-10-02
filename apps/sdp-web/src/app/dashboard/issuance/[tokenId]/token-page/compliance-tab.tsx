"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { PAYMENTS_TABLE_CELL } from "@/app/dashboard/payments/payments-table";
import { RecordBlock, RecordStack } from "@/components/refresh-record";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatTokenDay } from "../../issuance-token-state.redesign";
import { fetchTokenAllowlistPage, type TokenAllowlistPage } from "../asset-profile/allowlist.data";
import { TOKEN_ALLOWLIST_KEY } from "../asset-profile/allowlist-cache";
import type { TokenTabProps } from "./token-page.shared";
import { TokenTable } from "./token-table";

const PAGE_SIZE = 25;

type AccessControlMode = TokenTabProps["ops"]["accessControlMode"];
type AllowlistEntry = TokenAllowlistPage["entries"][number];

/** The token's access list, a page at a time; nothing is read while the token has none. */
function useComplianceEntries(tokenId: string, mode: AccessControlMode) {
  const [page, setPage] = useState(1);
  const { data, error } = useSWR<TokenAllowlistPage, Error>(
    mode === "disabled" ? null : [TOKEN_ALLOWLIST_KEY, tokenId, page, PAGE_SIZE, "", ""],
    () => fetchTokenAllowlistPage(tokenId, { page, pageSize: PAGE_SIZE }),
    { keepPreviousData: true }
  );
  const entries = (data?.entries ?? []).filter((entry) => entry.status !== "revoked");
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return { data, error, entries, total, page, setPage, pageCount };
}

type ComplianceEntries = ReturnType<typeof useComplianceEntries>;

/**
 * Who may hold the token: its access list (the addresses refused, or the only ones let in),
 * how many accounts are frozen, and a form that adds an address to the list.
 */
export function TokenComplianceTab({ token, ops, canManageTokenAdmin }: TokenTabProps) {
  const t = useTranslations();
  const mode = ops.accessControlMode;
  const list = useComplianceEntries(token.id, mode);
  const listDisabledReason = ops.complianceActionDisabledReasons.allowlist ?? null;

  if (mode === "disabled") {
    return (
      <RecordBlock title={t("DashboardIssuance.newDesign.compliance.noListTitle")}>
        <p className="max-w-[40em] text-body text-secondary">
          {t("DashboardIssuance.newDesign.compliance.noListBody")}
        </p>
      </RecordBlock>
    );
  }

  return (
    <RecordStack>
      <ComplianceListBlock
        token={token}
        ops={ops}
        canManageTokenAdmin={canManageTokenAdmin}
        allowlist={mode === "allowlist"}
        list={list}
        listDisabledReason={listDisabledReason}
      />
      {canManageTokenAdmin ? (
        <AddListEntryBlock
          ops={ops}
          canChange={!listDisabledReason}
          listDisabledReason={listDisabledReason}
        />
      ) : null}
    </RecordStack>
  );
}

/** The access list: what it does, how big it is, how many accounts are frozen, and its entries. */
function ComplianceListBlock({
  token,
  ops,
  canManageTokenAdmin,
  allowlist,
  list,
  listDisabledReason,
}: Pick<TokenTabProps, "token" | "ops" | "canManageTokenAdmin"> & {
  allowlist: boolean;
  list: ComplianceEntries;
  listDisabledReason: string | null;
}) {
  const t = useTranslations();
  return (
    <RecordBlock
      title={t(
        allowlist
          ? "DashboardIssuance.newDesign.compliance.approvedTitle"
          : "DashboardIssuance.newDesign.compliance.blockedTitle"
      )}
      className="gap-6"
    >
      {allowlist ? (
        <p className="max-w-[40em] text-body text-secondary">
          {t("DashboardIssuance.newDesign.compliance.approvedBody")}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-x-4">
        <span className="flex flex-col gap-1">
          <span className="text-meta text-secondary">
            {t(
              allowlist
                ? "DashboardIssuance.newDesign.compliance.approved"
                : "DashboardIssuance.newDesign.compliance.blocked"
            )}
          </span>
          <span className="text-body font-medium text-primary tabular-nums">
            {t("DashboardIssuance.newDesign.compliance.entries", { count: list.total })}
          </span>
        </span>
        <span className="flex flex-col gap-1">
          <span className="text-meta text-secondary">
            {t("DashboardIssuance.newDesign.compliance.frozenAccounts")}
          </span>
          <span className="text-body font-medium text-primary tabular-nums">
            {token.mintAddress
              ? (ops.frozenAccountsError ??
                t("DashboardIssuance.newDesign.compliance.accounts", {
                  count: ops.frozenAccountsTotal,
                }))
              : t("DashboardIssuance.newDesign.compliance.accounts", { count: 0 })}
          </span>
        </span>
      </div>
      <ComplianceEntriesView
        ops={ops}
        canManageTokenAdmin={canManageTokenAdmin}
        allowlist={allowlist}
        list={list}
        listDisabledReason={listDisabledReason}
      />
      {list.pageCount > 1 ? (
        <ArrowPagination page={list.page} pageCount={list.pageCount} onPageChange={list.setPage} />
      ) : null}
    </RecordBlock>
  );
}

/** The list's entries as a table, or why there are none to show. */
function ComplianceEntriesView({
  ops,
  canManageTokenAdmin,
  allowlist,
  list,
  listDisabledReason,
}: Pick<TokenTabProps, "ops" | "canManageTokenAdmin"> & {
  allowlist: boolean;
  list: ComplianceEntries;
  listDisabledReason: string | null;
}) {
  const t = useTranslations();
  if (list.error) {
    return <p className="text-body text-error">{t("DashboardIssuance.controlLists.loadError")}</p>;
  }
  if (list.data && list.entries.length === 0) {
    return (
      <div className="flex flex-col gap-1 py-2">
        <p className="text-body font-medium text-primary">
          {t("DashboardIssuance.newDesign.compliance.emptyTitle")}
        </p>
        {allowlist ? (
          <p className="max-w-[40em] text-body text-secondary">
            {t("DashboardIssuance.newDesign.compliance.emptyApproved")}
          </p>
        ) : null}
      </div>
    );
  }
  if (list.entries.length === 0) return null;
  return (
    <TokenTable
      className="mt-2"
      tableClassName="min-w-[560px]"
      columns={[
        { className: "w-[38%]", label: t("DashboardIssuance.newDesign.compliance.address") },
        { className: "w-[30%]", label: t("DashboardIssuance.newDesign.compliance.label") },
        { className: "w-[22%]", label: t("DashboardIssuance.newDesign.compliance.added") },
        {
          className: "w-[10%]",
          label: t("DashboardIssuance.newDesign.compliance.remove"),
          srOnly: true,
        },
      ]}
    >
      {list.entries.map((entry) => (
        <ComplianceEntryRow
          key={entry.id}
          entry={entry}
          ops={ops}
          canManageTokenAdmin={canManageTokenAdmin}
          removeDisabled={ops.isPending || Boolean(listDisabledReason)}
        />
      ))}
    </TokenTable>
  );
}

/** One address on the list: its label, when it was added, and a button that removes it. */
function ComplianceEntryRow({
  entry,
  ops,
  canManageTokenAdmin,
  removeDisabled,
}: Pick<TokenTabProps, "ops" | "canManageTokenAdmin"> & {
  entry: AllowlistEntry;
  removeDisabled: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <TableRow>
      <TableCell
        className={`${PAYMENTS_TABLE_CELL} truncate font-medium text-primary tabular-nums`}
      >
        {entry.address}
      </TableCell>
      <TableCell className={`${PAYMENTS_TABLE_CELL} truncate text-primary`}>
        {entry.label || "—"}
      </TableCell>
      <TableCell className={`${PAYMENTS_TABLE_CELL} text-primary`}>
        {entry.status === "pending"
          ? t("DashboardIssuance.newDesign.compliance.pending")
          : formatTokenDay(entry.createdAt, locale)}
      </TableCell>
      <TableCell className="text-right">
        {canManageTokenAdmin ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("DashboardIssuance.newDesign.compliance.removeEntry", {
              address: entry.address,
            })}
            disabled={removeDisabled}
            onClick={() => ops.handleRemoveAllowlist(entry.id)}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/** The form that puts an address, with an optional label, on the list. */
function AddListEntryBlock({
  ops,
  canChange,
  listDisabledReason,
}: Pick<TokenTabProps, "ops"> & { canChange: boolean; listDisabledReason: string | null }) {
  const t = useTranslations();
  return (
    <RecordBlock title={t("DashboardIssuance.newDesign.compliance.addTitle")} className="gap-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          ops.handleAddAllowlist();
        }}
      >
        <div className="grid gap-4 @xl:grid-cols-2">
          <ListEntryField
            id="token-list-address"
            label={t("DashboardIssuance.newDesign.compliance.address")}
            placeholder={t("DashboardIssuance.newDesign.compliance.addressPlaceholder")}
            value={ops.allowlistForm.address}
            disabled={ops.isPending}
            spellCheck={false}
            onChange={(address) => ops.setAllowlistForm((previous) => ({ ...previous, address }))}
          />
          <ListEntryField
            id="token-list-label"
            label={t("DashboardIssuance.newDesign.compliance.label")}
            placeholder={t("DashboardIssuance.newDesign.compliance.labelPlaceholder")}
            value={ops.allowlistForm.label}
            disabled={ops.isPending}
            onChange={(label) => ops.setAllowlistForm((previous) => ({ ...previous, label }))}
          />
        </div>
        {listDisabledReason ? (
          <p className="text-meta text-secondary">{listDisabledReason}</p>
        ) : null}
        <div className="flex">
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!canChange || ops.isPending || !ops.allowlistForm.address.trim()}
            iconLeft={<PlusIcon aria-hidden="true" />}
          >
            {t("DashboardIssuance.newDesign.compliance.addEntry")}
          </Button>
        </div>
      </form>
    </RecordBlock>
  );
}

/** One labelled text field of the add form. */
function ListEntryField({
  id,
  label,
  placeholder,
  value,
  disabled,
  spellCheck,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  spellCheck?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        size="xl"
        autoComplete="off"
        spellCheck={spellCheck}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}
