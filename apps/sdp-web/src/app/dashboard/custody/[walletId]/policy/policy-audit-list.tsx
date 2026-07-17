import type { WalletControlProfileRevisionHistory, WalletPolicyEvaluationDetail } from "@sdp/types";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDisplayLabel } from "@/lib/utils";
import {
  buildPolicyAuditSearchParams,
  hasPolicyAuditFilters,
  POLICY_AUDIT_OPERATION_FAMILIES,
  POLICY_AUDIT_OPERATION_STATUSES,
  type PolicyAuditFilters,
  type PolicyAuditListResult,
} from "./policy-audit.data";
import {
  DecisionBadge,
  formatAssetAmount,
  formatOperation,
  formatPolicyDateTime,
  formatRevisionReference,
  OperationStatusBadge,
  PolicyPageHeader,
  type PolicyTranslate,
  policyActor,
  shortIdentifier,
} from "./policy-audit.shared";

const REASON_CODES = [
  "implicit_default_allow",
  "wallet_policy_match",
  "api_key_policy_match",
  "wallet_policy_missing",
  "api_key_policy_missing",
  "manual_review",
  "provider_mapping_pending",
  "provider_mapping_partial",
  "provider_mapping_failed",
] as const;

export function PolicyAuditList({
  walletId,
  walletLabel,
  result,
  filters,
  revisionHistory,
  apiKeyNames,
  locale,
  t,
}: {
  walletId: string;
  walletLabel: string;
  result: PolicyAuditListResult;
  filters: PolicyAuditFilters;
  revisionHistory: WalletControlProfileRevisionHistory;
  apiKeyNames: Record<string, string>;
  locale: string;
  t: PolicyTranslate;
}) {
  const encodedWalletId = encodeURIComponent(walletId);
  const policyHref = `/dashboard/wallets/${encodedWalletId}/policy`;
  const auditHref = `${policyHref}/audit`;
  const revisionsHref = `${policyHref}/revisions`;
  const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
  const rangeStart = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const rangeEnd = Math.min(result.page * result.pageSize, result.total);

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-6">
      <PolicyPageHeader
        backHref={policyHref}
        backLabel={t("DashboardCustody.policyAuditBackToWalletControls")}
        title={t("DashboardCustody.policyAuditTitle")}
        trailing={
          <Button asChild variant="outline" size="sm">
            <Link href={revisionsHref}>
              <History className="size-4" />
              {t("DashboardCustody.policyAuditRevisionHistory")}
            </Link>
          </Button>
        }
      />

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-medium text-primary">
            {t("DashboardCustody.policyAuditWalletHistory", { wallet: walletLabel })}
          </h2>
          <p className="mt-1 text-sm text-secondary">
            {t("DashboardCustody.policyAuditWalletHistoryDescription")}
          </p>
        </div>

        <form action={auditHref} className="space-y-4 border-y border-border-default py-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(150px,1fr))_auto]">
            <FilterField label={t("DashboardCustody.policyAuditDecision")}>
              <select
                name="decision"
                defaultValue={filters.decision ?? ""}
                className={filterControlClassName}
              >
                <option value="">{t("DashboardCustody.policyAuditAllDecisions")}</option>
                <option value="allow">{t("DashboardCustody.policyAuditAllowed")}</option>
                <option value="deny">{t("DashboardCustody.policyAuditBlocked")}</option>
                <option value="approval_required">
                  {t("DashboardCustody.policyAuditApprovalRequired")}
                </option>
                <option value="review">{t("DashboardCustody.policyAuditReview")}</option>
              </select>
            </FilterField>

            <FilterField label={t("DashboardCustody.policyAuditOperationFamily")}>
              <select
                name="operationFamily"
                defaultValue={filters.operationFamily ?? ""}
                className={filterControlClassName}
              >
                <option value="">{t("DashboardCustody.policyAuditAllFamilies")}</option>
                {POLICY_AUDIT_OPERATION_FAMILIES.map((family) => (
                  <option key={family} value={family}>
                    {formatDisplayLabel(family)}
                  </option>
                ))}
              </select>
            </FilterField>

            <FilterField label={t("DashboardCustody.policyAuditFromDate")}>
              <input
                type="date"
                name="from"
                defaultValue={filters.from}
                max={filters.to}
                className={filterControlClassName}
              />
            </FilterField>

            <FilterField label={t("DashboardCustody.policyAuditToDate")}>
              <input
                type="date"
                name="to"
                defaultValue={filters.to}
                min={filters.from}
                className={filterControlClassName}
              />
            </FilterField>

            <div className="flex items-end gap-2">
              <Button type="submit" size="sm">
                {t("DashboardCustody.policyAuditApplyFilters")}
              </Button>
              {hasPolicyAuditFilters(filters) ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href={auditHref}>{t("DashboardCustody.policyAuditClearFilters")}</Link>
                </Button>
              ) : null}
            </div>
          </div>

          <details open={Boolean(filters.status || filters.reasonCode)} className="group">
            <summary className="w-fit cursor-pointer list-none text-sm text-secondary transition-colors hover:text-primary">
              {t("DashboardCustody.policyAuditMoreFilters")}
              <ChevronRight className="ml-1 inline size-4 transition-transform group-open:rotate-90" />
            </summary>
            <div className="mt-3 grid max-w-2xl gap-3 md:grid-cols-2">
              <FilterField label={t("DashboardCustody.policyAuditOperationStatus")}>
                <select
                  name="status"
                  defaultValue={filters.status ?? ""}
                  className={filterControlClassName}
                >
                  <option value="">{t("DashboardCustody.policyAuditAllStatuses")}</option>
                  {POLICY_AUDIT_OPERATION_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {formatDisplayLabel(status)}
                    </option>
                  ))}
                </select>
              </FilterField>

              <FilterField label={t("DashboardCustody.policyAuditReasonCode")}>
                <select
                  name="reasonCode"
                  defaultValue={filters.reasonCode ?? ""}
                  className={filterControlClassName}
                >
                  <option value="">{t("DashboardCustody.policyAuditAllReasons")}</option>
                  {REASON_CODES.map((reasonCode) => (
                    <option key={reasonCode} value={reasonCode}>
                      {formatDisplayLabel(reasonCode)}
                    </option>
                  ))}
                </select>
              </FilterField>
            </div>
          </details>
        </form>

        {result.evaluations.length === 0 ? (
          <div className="border-y border-border-default py-16 text-center">
            <p className="text-sm font-medium text-primary">
              {t("DashboardCustody.policyAuditEmpty")}
            </p>
            <p className="mt-1 text-sm text-secondary">
              {hasPolicyAuditFilters(filters)
                ? t("DashboardCustody.policyAuditEmptyFiltered")
                : t("DashboardCustody.policyAuditEmptyDescription")}
            </p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border-default border-y border-border-default lg:hidden">
              {result.evaluations.map((evaluation) => (
                <MobileAuditRow
                  key={evaluation.id}
                  evaluation={evaluation}
                  href={auditDetailHref(auditHref, evaluation.id, filters, result.page)}
                  revision={formatRevisionReference(
                    revisionHistory,
                    evaluation.policyRevisions.wallet.evaluatedRevisionId,
                    t("DashboardCustody.policyAuditDefaultAllow")
                  )}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>

            <div className="hidden lg:block">
              <Table className="min-w-0 [&_table]:min-w-[1040px] [&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">
                      {t("DashboardCustody.policyAuditDecision")}
                    </TableHead>
                    <TableHead className="w-[245px]">
                      {t("DashboardCustody.policyAuditOperation")}
                    </TableHead>
                    <TableHead className="w-[145px]">
                      {t("DashboardCustody.policyAuditAssetAmount")}
                    </TableHead>
                    <TableHead className="w-[145px]">
                      {t("DashboardCustody.policyAuditDestination")}
                    </TableHead>
                    <TableHead className="w-[170px]">
                      {t("DashboardCustody.policyAuditApiKeyActor")}
                    </TableHead>
                    <TableHead className="w-[120px]">
                      {t("DashboardCustody.policyAuditAppliedRevision")}
                    </TableHead>
                    <TableHead className="w-[170px]">
                      {t("DashboardCustody.policyAuditEvaluated")}
                    </TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">
                        {t("DashboardCustody.policyAuditOpenEvaluation")}
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.evaluations.map((evaluation) => {
                    const detailHref = auditDetailHref(
                      auditHref,
                      evaluation.id,
                      filters,
                      result.page
                    );
                    const actor = policyActor(evaluation, apiKeyNames);
                    const appliedRevision = formatRevisionReference(
                      revisionHistory,
                      evaluation.policyRevisions.wallet.evaluatedRevisionId,
                      t("DashboardCustody.policyAuditDefaultAllow")
                    );

                    return (
                      <TableRow key={evaluation.id} className="group hover:bg-fill-subtle">
                        <AuditCell>
                          <DecisionBadge decision={evaluation.decision} t={t} />
                        </AuditCell>
                        <AuditCell>
                          <Link
                            href={detailHref}
                            className="font-medium text-primary outline-none hover:underline focus-visible:underline"
                          >
                            {formatOperation(evaluation)}
                          </Link>
                          <div className="mt-1">
                            <OperationStatusBadge status={evaluation.walletOperation.status} />
                          </div>
                        </AuditCell>
                        <AuditCell>{formatAssetAmount(evaluation, "-")}</AuditCell>
                        <AuditCell>
                          <span title={evaluation.walletOperation.destination ?? undefined}>
                            {evaluation.walletOperation.destination
                              ? shortIdentifier(evaluation.walletOperation.destination, 5)
                              : "-"}
                          </span>
                        </AuditCell>
                        <AuditCell>
                          <p>
                            {actor.type === "api_key" && !actor.name
                              ? shortIdentifier(actor.id ?? actor.value)
                              : actor.value || "-"}
                          </p>
                          {actor.id && actor.name ? (
                            <p className="mt-1 text-xs text-tertiary" title={actor.id}>
                              {shortIdentifier(actor.id)}
                            </p>
                          ) : null}
                        </AuditCell>
                        <AuditCell>{appliedRevision}</AuditCell>
                        <AuditCell>
                          {formatPolicyDateTime(evaluation.evaluatedAt, locale)}
                        </AuditCell>
                        <TableCell className="px-2">
                          <Button asChild variant="ghost" size="icon-sm">
                            <Link
                              href={detailHref}
                              aria-label={t("DashboardCustody.policyAuditOpenEvaluation")}
                            >
                              <ChevronRight className="size-4" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-secondary">
            {t("DashboardCustody.policyAuditRange", {
              from: rangeStart,
              to: rangeEnd,
              total: result.total,
            })}
          </p>
          {pageCount > 1 ? (
            <div className="flex items-center gap-2">
              <PaginationButton
                href={pageHref(auditHref, filters, result.page - 1)}
                disabled={result.page <= 1}
                label={t("DashboardCustody.policyAuditPreviousPage")}
              >
                <ChevronLeft className="size-4" />
              </PaginationButton>
              <span className="min-w-16 text-center text-xs text-secondary">
                {t("DashboardCustody.policyAuditPageOf", { page: result.page, pageCount })}
              </span>
              <PaginationButton
                href={pageHref(auditHref, filters, result.page + 1)}
                disabled={result.page >= pageCount}
                label={t("DashboardCustody.policyAuditNextPage")}
              >
                <ChevronRight className="size-4" />
              </PaginationButton>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

const filterControlClassName =
  "h-10 w-full rounded-md border border-border-default bg-white px-3 text-sm text-primary outline-none transition-colors focus:border-primary";

function MobileAuditRow({
  evaluation,
  href,
  revision,
  locale,
  t,
}: {
  evaluation: WalletPolicyEvaluationDetail;
  href: string;
  revision: string;
  locale: string;
  t: PolicyTranslate;
}) {
  return (
    <Link
      href={href}
      className="group grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4 outline-none transition-colors hover:bg-fill-subtle focus-visible:bg-fill-subtle"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <DecisionBadge decision={evaluation.decision} t={t} />
          <OperationStatusBadge status={evaluation.walletOperation.status} />
        </div>
        <p className="mt-3 text-sm font-medium text-primary">{formatOperation(evaluation)}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <MobileAuditValue
            label={t("DashboardCustody.policyAuditAssetAmount")}
            value={formatAssetAmount(evaluation, "-")}
          />
          <MobileAuditValue
            label={t("DashboardCustody.policyAuditAppliedRevision")}
            value={revision}
          />
          <MobileAuditValue
            label={t("DashboardCustody.policyAuditDestination")}
            value={
              evaluation.walletOperation.destination
                ? shortIdentifier(evaluation.walletOperation.destination, 5)
                : "-"
            }
          />
          <MobileAuditValue
            label={t("DashboardCustody.policyAuditEvaluated")}
            value={formatPolicyDateTime(evaluation.evaluatedAt, locale)}
          />
        </dl>
      </div>
      <ChevronRight className="mt-1 size-4 text-tertiary transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function MobileAuditValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-tertiary">{label}</dt>
      <dd className="mt-0.5 truncate text-secondary" title={value}>
        {value}
      </dd>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="block text-xs font-medium text-secondary">{label}</legend>
      {children}
    </fieldset>
  );
}

function AuditCell({ children }: { children: ReactNode }) {
  return (
    <TableCell className="!whitespace-normal px-4 py-3 text-sm font-normal text-primary">
      {children}
    </TableCell>
  );
}

function pageHref(baseHref: string, filters: PolicyAuditFilters, page: number): string {
  const query = buildPolicyAuditSearchParams(filters, { page });
  return query.size > 0 ? `${baseHref}?${query}` : baseHref;
}

function auditDetailHref(
  auditHref: string,
  evaluationId: string,
  filters: PolicyAuditFilters,
  page: number
): string {
  const query = buildPolicyAuditSearchParams(filters, { page });
  query.set("tab", "decision");
  return `${auditHref}/${encodeURIComponent(evaluationId)}?${query}`;
}

function PaginationButton({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: ReactNode;
}) {
  return disabled ? (
    <Button type="button" variant="outline" size="icon-sm" disabled aria-label={label}>
      {children}
    </Button>
  ) : (
    <Button asChild variant="outline" size="icon-sm">
      <Link href={href} aria-label={label} title={label}>
        {children}
      </Link>
    </Button>
  );
}
