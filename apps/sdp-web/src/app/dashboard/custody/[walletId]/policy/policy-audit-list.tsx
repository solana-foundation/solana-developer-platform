import type { WalletControlProfileRevisionHistory, WalletPolicyEvaluationDetail } from "@sdp/types";
import { ChevronRight, ScrollText } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { resolveTokenByMint } from "@/app/dashboard/payments/payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "@/app/dashboard/payments/payments-page.data";
import { DashboardWorkspaceCard } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAvatar } from "@/components/user-avatar";
import { formatDisplayLabel } from "@/lib/utils";
import {
  buildPolicyAuditSearchParams,
  hasPolicyAuditFilters,
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
  type PolicyTranslate,
  policyActor,
  shortIdentifier,
} from "./policy-audit.shared";
import { PolicyAuditFilterBar, PolicyAuditPaginatedFooter } from "./policy-audit-filter-bar";
import { RevisionHistoryDrawer } from "./revision-history-drawer";

export function PolicyAuditList({
  walletId,
  walletLabel,
  result,
  filters,
  revisionHistory,
  apiKeyNames,
  userNames,
  issuedTokensByMint,
  locale,
  t,
}: {
  walletId: string;
  walletLabel: string;
  result: PolicyAuditListResult;
  filters: PolicyAuditFilters;
  revisionHistory: WalletControlProfileRevisionHistory;
  apiKeyNames: Record<string, string>;
  userNames: Record<string, string>;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  locale: string;
  t: PolicyTranslate;
}) {
  const encodedWalletId = encodeURIComponent(walletId);
  const policyHref = `/dashboard/wallets/${encodedWalletId}/policy`;
  const auditHref = `${policyHref}/audit`;
  const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
  const rangeStart = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const rangeEnd = Math.min(result.page * result.pageSize, result.total);

  return (
    <div className="flex w-full flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-primary sm:text-3xl">
            {t("DashboardCustody.policyAuditWalletHistory", { wallet: walletLabel })}
          </h1>
          <p className="mt-1 text-sm text-secondary">
            {t("DashboardCustody.policyAuditWalletHistoryDescription")}
          </p>
        </div>
        <RevisionHistoryDrawer
          walletId={walletId}
          preloaded={{ history: revisionHistory, userNames }}
        />
      </div>

      <DashboardWorkspaceCard>
        <PolicyAuditFilterBar filters={filters} />

        {result.evaluations.length === 0 ? (
          <ListEmptyState
            icon={<ScrollText className="size-5" />}
            message={t("DashboardCustody.policyAuditEmpty")}
            description={
              hasPolicyAuditFilters(filters)
                ? t("DashboardCustody.policyAuditEmptyFiltered")
                : t("DashboardCustody.policyAuditEmptyDescription")
            }
          />
        ) : (
          <>
            <div className="divide-y divide-border-default border-b border-border-default lg:hidden">
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
                  issuedTokensByMint={issuedTokensByMint}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>

            <div className="hidden lg:block">
              <Table className="min-w-0 rounded-none border-0 [&_table]:min-w-[1120px] [&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[150px]">
                      {t("DashboardCustody.policyAuditDecision")}
                    </TableHead>
                    <TableHead className="w-[110px]">
                      {t("DashboardCustody.policyAuditOperationFamily")}
                    </TableHead>
                    <TableHead className="w-[180px]">
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
                    const actor = policyActor(evaluation, apiKeyNames, userNames);
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
                          {formatDisplayLabel(evaluation.walletOperation.operationFamily)}
                        </AuditCell>
                        <AuditCell>
                          <Link
                            href={detailHref}
                            className="font-medium text-primary outline-none hover:underline focus-visible:underline"
                          >
                            {operationTypeLabel(evaluation)}
                          </Link>
                          <div className="mt-1">
                            <OperationStatusBadge status={evaluation.walletOperation.status} />
                          </div>
                        </AuditCell>
                        <AuditCell>
                          <AssetAmount
                            evaluation={evaluation}
                            issuedTokensByMint={issuedTokensByMint}
                          />
                        </AuditCell>
                        <AuditCell>
                          <span title={evaluation.walletOperation.destination ?? undefined}>
                            {evaluation.walletOperation.destination
                              ? shortIdentifier(evaluation.walletOperation.destination, 5)
                              : "-"}
                          </span>
                        </AuditCell>
                        <AuditCell>
                          <div className="flex min-w-0 items-center gap-2">
                            {actor.type === "actor" && actor.name ? (
                              <UserAvatar name={actor.name} className="size-5 text-[9px]" />
                            ) : null}
                            <p
                              className="min-w-0 truncate"
                              data-policy-audit-actor
                              title={actor.value || undefined}
                            >
                              {actor.type === "api_key" && !actor.name
                                ? shortIdentifier(actor.id ?? actor.value)
                                : actor.value || "-"}
                            </p>
                          </div>
                          {actor.id && actor.name ? (
                            <p
                              className="mt-1 flex items-center gap-1 text-xs text-tertiary"
                              title={actor.id}
                            >
                              {shortIdentifier(actor.id)}
                              <WalletMetadataCopyButton
                                value={actor.id}
                                label={t(
                                  actor.type === "api_key"
                                    ? "DashboardCustody.policyAuditApiKeyId"
                                    : "DashboardCustody.policyAuditUserId"
                                )}
                              />
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

            <PolicyAuditPaginatedFooter
              filters={filters}
              page={result.page}
              pageCount={pageCount}
              summary={t("DashboardCustody.policyAuditRange", {
                from: rangeStart,
                to: rangeEnd,
                total: result.total,
              })}
            />
          </>
        )}
      </DashboardWorkspaceCard>
    </div>
  );
}

function MobileAuditRow({
  evaluation,
  href,
  revision,
  issuedTokensByMint,
  locale,
  t,
}: {
  evaluation: WalletPolicyEvaluationDetail;
  href: string;
  revision: string;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  locale: string;
  t: PolicyTranslate;
}) {
  return (
    <Link
      href={href}
      className="group grid grid-cols-[minmax(0,1fr)_auto] gap-4 p-4 outline-none transition-colors hover:bg-fill-subtle focus-visible:bg-fill-subtle"
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
            value={formatAssetAmount(evaluation, "-", issuedTokensByMint)}
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

/**
 * Formats the operation type without the module prefix the Module column
 * already shows. Types that do not start with their family (e.g.
 * `custody_signer_check` under `raw_sign`) render in full.
 *
 * @param evaluation - The audit row's evaluation.
 * @returns The display label for the Operation column.
 */
function operationTypeLabel(evaluation: WalletPolicyEvaluationDetail): string {
  const { operationFamily, operationType } = evaluation.walletOperation;
  return formatDisplayLabel(
    operationType.startsWith(`${operationFamily}_`)
      ? operationType.slice(operationFamily.length + 1)
      : operationType
  );
}

function AssetAmount({
  evaluation,
  issuedTokensByMint,
}: {
  evaluation: WalletPolicyEvaluationDetail;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
}) {
  const { asset } = evaluation.walletOperation;
  if (!asset) return formatAssetAmount(evaluation, "-", issuedTokensByMint);

  const resolved = resolveTokenByMint(asset, issuedTokensByMint);
  return (
    <span className="flex items-center gap-2" title={asset}>
      <TokenMark
        mint={asset}
        symbol={resolved.tokenName}
        logoUrl={resolved.metadataImageUrl}
        size="xs"
      />
      <span className="min-w-0 truncate">
        {formatAssetAmount(evaluation, "-", issuedTokensByMint)}
      </span>
    </span>
  );
}

function AuditCell({ children }: { children: ReactNode }) {
  return (
    <TableCell className="min-w-0 !whitespace-normal px-4 py-3 text-sm font-normal text-primary">
      {children}
    </TableCell>
  );
}

function auditDetailHref(
  auditHref: string,
  evaluationId: string,
  filters: PolicyAuditFilters,
  page: number
): string {
  const query = buildPolicyAuditSearchParams(filters, { page }).toString();
  return `${auditHref}/${encodeURIComponent(evaluationId)}${query ? `?${query}` : ""}`;
}
