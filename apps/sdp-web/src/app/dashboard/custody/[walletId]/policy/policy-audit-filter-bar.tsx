"use client";

import type { PolicyDecision } from "@sdp/types";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DateRangePicker } from "@/components/ui/date-picker";
import { PaginatedFooter } from "@/components/ui/paginated-footer";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { cn, formatDisplayLabel } from "@/lib/utils";
import {
  buildPolicyAuditSearchParams,
  POLICY_AUDIT_OPERATION_FAMILIES,
  POLICY_AUDIT_OPERATION_STATUSES,
  type PolicyAuditFilters,
} from "./policy-audit.data";

const DECISION_OPTIONS = [
  "allow",
  "deny",
  "approval_required",
  "review",
] as const satisfies readonly PolicyDecision[];

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

/**
 * URL-backed filter navigation for the audit page: merges overrides into the
 * current filters and replaces the route so the server re-renders the list.
 *
 * @param filters - The filters currently applied, parsed from the URL.
 * @returns The `apply` navigation callback.
 */
function usePolicyAuditNavigation(
  filters: PolicyAuditFilters
): (overrides: Partial<PolicyAuditFilters>) => void {
  const router = useRouter();
  const pathname = usePathname();
  return (overrides) => {
    const query = buildPolicyAuditSearchParams(filters, overrides);
    router.replace(query.size > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
  };
}

/**
 * Audit filter row: every control applies immediately on change by rewriting
 * the URL's search params (resetting to page 1), no submit step. The date
 * range only commits once both ends are chosen, which DateRangePicker
 * guarantees.
 *
 * @param props.filters - The filters currently applied, parsed from the URL.
 * @returns The filter bar element.
 */
export function PolicyAuditFilterBar({ filters }: { filters: PolicyAuditFilters }) {
  const t = useTranslations();
  const apply = usePolicyAuditNavigation(filters);

  return (
    <div className="grid gap-3 border-b border-border-default p-3 md:grid-cols-2 xl:grid-cols-5">
      <FilterField label={t("DashboardCustody.policyAuditDecision")}>
        <Select
          value={filters.decision ?? ""}
          placeholder={t("DashboardCustody.policyAuditAllDecisions")}
          ariaLabel={t("DashboardCustody.policyAuditDecision")}
          onValueChange={(next) =>
            apply({ decision: DECISION_OPTIONS.find((option) => option === next), page: 1 })
          }
        >
          <SelectItem value="">{t("DashboardCustody.policyAuditAllDecisions")}</SelectItem>
          <SelectItem value="allow">{t("DashboardCustody.policyAuditAllowed")}</SelectItem>
          <SelectItem value="deny">{t("DashboardCustody.policyAuditBlocked")}</SelectItem>
          <SelectItem value="approval_required">
            {t("DashboardCustody.policyAuditApprovalRequired")}
          </SelectItem>
          <SelectItem value="review">{t("DashboardCustody.policyAuditReview")}</SelectItem>
        </Select>
      </FilterField>

      <FilterField label={t("DashboardCustody.policyAuditOperationFamily")}>
        <Select
          value={filters.operationFamily ?? ""}
          placeholder={t("DashboardCustody.policyAuditAllFamilies")}
          ariaLabel={t("DashboardCustody.policyAuditOperationFamily")}
          onValueChange={(next) =>
            apply({
              operationFamily: POLICY_AUDIT_OPERATION_FAMILIES.find((option) => option === next),
              page: 1,
            })
          }
        >
          <SelectItem value="">{t("DashboardCustody.policyAuditAllFamilies")}</SelectItem>
          {POLICY_AUDIT_OPERATION_FAMILIES.map((family) => (
            <SelectItem key={family} value={family}>
              {formatDisplayLabel(family)}
            </SelectItem>
          ))}
        </Select>
      </FilterField>

      <FilterField label={t("DashboardCustody.policyAuditOperationStatus")}>
        <Select
          value={filters.status ?? ""}
          placeholder={t("DashboardCustody.policyAuditAllStatuses")}
          ariaLabel={t("DashboardCustody.policyAuditOperationStatus")}
          onValueChange={(next) =>
            apply({
              status: POLICY_AUDIT_OPERATION_STATUSES.find((option) => option === next),
              page: 1,
            })
          }
        >
          <SelectItem value="">{t("DashboardCustody.policyAuditAllStatuses")}</SelectItem>
          {POLICY_AUDIT_OPERATION_STATUSES.map((status) => (
            <SelectItem key={status} value={status}>
              {formatDisplayLabel(status)}
            </SelectItem>
          ))}
        </Select>
      </FilterField>

      <FilterField label={t("DashboardCustody.policyAuditReasonCode")}>
        <Select
          value={filters.reasonCode ?? ""}
          placeholder={t("DashboardCustody.policyAuditAllReasons")}
          ariaLabel={t("DashboardCustody.policyAuditReasonCode")}
          onValueChange={(next) =>
            apply({ reasonCode: REASON_CODES.find((option) => option === next), page: 1 })
          }
        >
          <SelectItem value="">{t("DashboardCustody.policyAuditAllReasons")}</SelectItem>
          {REASON_CODES.map((reasonCode) => (
            <SelectItem key={reasonCode} value={reasonCode}>
              {formatDisplayLabel(reasonCode)}
            </SelectItem>
          ))}
        </Select>
      </FilterField>

      <FilterField label={t("DashboardCustody.policyAuditHistoryRange")}>
        <DateRangePicker
          from={filters.from ?? ""}
          to={filters.to ?? ""}
          disableFuture
          ariaLabel={t("DashboardCustody.policyAuditHistoryRange")}
          onChange={(from, to) => apply({ from: from || undefined, to: to || undefined, page: 1 })}
        />
      </FilterField>
    </div>
  );
}

/**
 * Audit list footer: the shared PaginatedFooter, navigating by rewriting the
 * URL's `page`/`pageSize` params so page changes re-render the server list.
 *
 * @param props.filters - The filters currently applied, parsed from the URL.
 * @param props.page - The page the server actually rendered; local date
 *   filtering clamps out-of-range URL pages, so this can differ from
 *   `filters.page`.
 * @param props.pageCount - Total number of pages.
 * @param props.summary - Localized "x–y of z" summary from the server.
 * @returns The footer element.
 */
export function PolicyAuditPaginatedFooter({
  filters,
  page,
  pageCount,
  summary,
}: {
  filters: PolicyAuditFilters;
  page: number;
  pageCount: number;
  summary: string;
}) {
  const apply = usePolicyAuditNavigation(filters);
  return (
    <PaginatedFooter
      className="mt-auto"
      page={page}
      pageCount={pageCount}
      onPageChange={(page) => apply({ page })}
      summary={summary}
      pageSizeControl={{
        pageSize: filters.pageSize,
        onPageSizeChange: (pageSize) => apply({ pageSize, page: 1 }),
      }}
    />
  );
}

function FilterField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className={cn("space-y-1.5", className)}>
      <legend className="block text-xs font-medium text-secondary">{label}</legend>
      {children}
    </fieldset>
  );
}
