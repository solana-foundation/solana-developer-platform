"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "@/app/dashboard/payments/payments-table";
import { RecordBlock, RecordStack } from "@/components/refresh-record";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatTokenDay } from "../../issuance-token-state.redesign";
import { fetchTokenAllowlistPage, type TokenAllowlistPage } from "../asset-profile/allowlist.data";
import { TOKEN_ALLOWLIST_KEY } from "../asset-profile/allowlist-cache";
import type { TokenTabProps } from "./token-page.shared";

const PAGE_SIZE = 25;

/**
 * Who may hold the token: its access list (the addresses refused, or the only ones let in),
 * how many accounts are frozen, and a form that adds an address to the list.
 */
export function TokenComplianceTab({ token, ops, canManageTokenAdmin }: TokenTabProps) {
  const t = useTranslations();
  const locale = useLocale();
  const mode = ops.accessControlMode;
  const [page, setPage] = useState(1);
  const { data, error } = useSWR<TokenAllowlistPage, Error>(
    mode === "disabled" ? null : [TOKEN_ALLOWLIST_KEY, token.id, page, PAGE_SIZE, "", ""],
    () => fetchTokenAllowlistPage(token.id, { page, pageSize: PAGE_SIZE }),
    { keepPreviousData: true }
  );
  const entries = (data?.entries ?? []).filter((entry) => entry.status !== "revoked");
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allowlist = mode === "allowlist";
  const listDisabledReason = ops.complianceActionDisabledReasons.allowlist ?? null;
  const canChange = canManageTokenAdmin && !listDisabledReason;

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
      <RecordBlock
        title={t(
          allowlist
            ? "DashboardIssuance.newDesign.compliance.approvedTitle"
            : "DashboardIssuance.newDesign.compliance.blockedTitle"
        )}
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
              {t("DashboardIssuance.newDesign.compliance.entries", { count: total })}
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
        {error ? (
          <p className="text-body text-error">{t("DashboardIssuance.controlLists.loadError")}</p>
        ) : data && entries.length === 0 ? (
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
        ) : entries.length > 0 ? (
          <div className="mt-2 overflow-x-auto refresh:-mx-3">
            <Table className="min-w-[560px] table-fixed rounded-none border-0">
              <colgroup>
                <col className="w-[38%]" />
                <col className="w-[30%]" />
                <col className="w-[22%]" />
                <col className="w-[10%]" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className={PAYMENTS_TABLE_HEAD}>
                    {t("DashboardIssuance.newDesign.compliance.address")}
                  </TableHead>
                  <TableHead className={PAYMENTS_TABLE_HEAD}>
                    {t("DashboardIssuance.newDesign.compliance.label")}
                  </TableHead>
                  <TableHead className={PAYMENTS_TABLE_HEAD}>
                    {t("DashboardIssuance.newDesign.compliance.added")}
                  </TableHead>
                  <TableHead>
                    <span className="sr-only">
                      {t("DashboardIssuance.newDesign.compliance.remove")}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
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
                          disabled={ops.isPending || Boolean(listDisabledReason)}
                          onClick={() => ops.handleRemoveAllowlist(entry.id)}
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {pageCount > 1 ? (
          <ArrowPagination page={page} pageCount={pageCount} onPageChange={setPage} />
        ) : null}
      </RecordBlock>

      {canManageTokenAdmin ? (
        <RecordBlock title={t("DashboardIssuance.newDesign.compliance.addTitle")}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              ops.handleAddAllowlist();
            }}
          >
            <div className="grid gap-4 @xl:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="token-list-address">
                  {t("DashboardIssuance.newDesign.compliance.address")}
                </Label>
                <Input
                  id="token-list-address"
                  size="xl"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("DashboardIssuance.newDesign.compliance.addressPlaceholder")}
                  value={ops.allowlistForm.address}
                  disabled={ops.isPending}
                  onChange={(event) => {
                    const address = event.currentTarget.value;
                    ops.setAllowlistForm((previous) => ({ ...previous, address }));
                  }}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="token-list-label">
                  {t("DashboardIssuance.newDesign.compliance.label")}
                </Label>
                <Input
                  id="token-list-label"
                  size="xl"
                  autoComplete="off"
                  placeholder={t("DashboardIssuance.newDesign.compliance.labelPlaceholder")}
                  value={ops.allowlistForm.label}
                  disabled={ops.isPending}
                  onChange={(event) => {
                    const label = event.currentTarget.value;
                    ops.setAllowlistForm((previous) => ({ ...previous, label }));
                  }}
                />
              </div>
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
              >
                <PlusIcon aria-hidden="true" />
                {t("DashboardIssuance.newDesign.compliance.addEntry")}
              </Button>
            </div>
          </form>
        </RecordBlock>
      ) : null}
    </RecordStack>
  );
}
