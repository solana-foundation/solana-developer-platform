import type {
  CustodyWalletMetadataResponse,
  PolicyDecision,
  WalletControlProfileRevisionHistory,
  WalletPolicyEvaluationDetail,
} from "@sdp/types";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  ChevronRight,
  CircleMinus,
  Clock3,
  ExternalLink,
  FileKey,
  KeyRound,
  ShieldCheck,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDisplayLabel } from "@/lib/utils";
import {
  buildPolicyAuditSearchParams,
  type PolicyAuditFilters,
  type PolicyAuditNeighbor,
  type PolicyAuditNeighbors,
} from "./policy-audit.data";
import {
  DecisionBadge,
  decisionHeading,
  formatPolicyDateTime,
  formatRevisionReference,
  type PolicyTranslate,
  policyActor,
  requestIdFromEvaluation,
  shortIdentifier,
} from "./policy-audit.shared";
import { PolicyRevisionExplorer } from "./policy-revision-explorer";

export type PolicyAuditDetailTab = "decision" | "request" | "revisions";

export function PolicyAuditDetail({
  wallet,
  evaluation,
  revisionHistory,
  apiKeyNames,
  neighbors,
  filters,
  tab,
  selectedRevisionId,
  locale,
  t,
}: {
  wallet: CustodyWalletMetadataResponse["wallet"];
  evaluation: WalletPolicyEvaluationDetail;
  revisionHistory: WalletControlProfileRevisionHistory;
  apiKeyNames: Record<string, string>;
  neighbors: PolicyAuditNeighbors;
  filters: PolicyAuditFilters;
  tab: PolicyAuditDetailTab;
  selectedRevisionId?: string;
  locale: string;
  t: PolicyTranslate;
}) {
  const encodedWalletId = encodeURIComponent(wallet.walletId);
  const policyHref = `/dashboard/wallets/${encodedWalletId}/policy`;
  const auditHref = `${policyHref}/audit`;
  const detailBaseHref = `${auditHref}/${encodeURIComponent(evaluation.id)}`;
  const backQuery = buildPolicyAuditSearchParams(filters);
  const backHref = backQuery.size > 0 ? `${auditHref}?${backQuery}` : auditHref;
  const actor = policyActor(evaluation, apiKeyNames);
  const requestId = requestIdFromEvaluation(evaluation);

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-default pb-4">
        <nav
          className="flex items-center gap-2 text-sm"
          aria-label={t("DashboardCustody.policyAuditBreadcrumb")}
        >
          <Link href={backHref} className="text-secondary transition-colors hover:text-primary">
            {t("DashboardCustody.policyAuditTitle")}
          </Link>
          <ChevronRight className="size-4 text-tertiary" />
          <span className="text-primary">{t("DashboardCustody.policyAuditEvaluation")}</span>
        </nav>
        <div className="flex items-center gap-2">
          <NeighborButton
            direction="previous"
            neighbor={neighbors.previous}
            href={neighborHref(
              detailBaseHref,
              neighbors.previous,
              filters,
              tab,
              selectedRevisionId
            )}
            t={t}
          />
          <NeighborButton
            direction="next"
            neighbor={neighbors.next}
            href={neighborHref(detailBaseHref, neighbors.next, filters, tab, selectedRevisionId)}
            t={t}
          />
        </div>
      </div>

      <section>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-medium text-primary sm:text-3xl">
            {decisionHeading(evaluation)}
          </h2>
          <DecisionBadge decision={evaluation.decision} t={t} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-secondary">
          <MetadataLine icon={<CalendarClock className="size-4" />}>
            {formatPolicyDateTime(evaluation.evaluatedAt, locale)}
          </MetadataLine>
          <MetadataLine icon={<WalletCards className="size-4" />}>
            {walletLabel(wallet)}
          </MetadataLine>
          {requestId ? (
            <MetadataLine icon={<FileKey className="size-4" />}>
              <span>{shortIdentifier(requestId)}</span>
              <WalletMetadataCopyButton
                value={requestId}
                label={t("DashboardCustody.policyAuditRequestId")}
              />
            </MetadataLine>
          ) : null}
          {actor.value ? (
            <MetadataLine
              icon={
                actor.type === "api_key" ? (
                  <KeyRound className="size-4" />
                ) : (
                  <UserRound className="size-4" />
                )
              }
            >
              <span
                className="min-w-0 flex-1 truncate"
                data-policy-audit-detail-actor
                title={actor.value}
              >
                {actor.type === "api_key" && !actor.name
                  ? shortIdentifier(actor.value)
                  : actor.value}
              </span>
            </MetadataLine>
          ) : null}
        </div>
      </section>

      <div
        className={
          tab === "revisions" ? "min-w-0" : "grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_340px]"
        }
      >
        <main className="min-w-0">
          <DetailTabs
            activeTab={tab}
            detailBaseHref={detailBaseHref}
            filters={filters}
            selectedRevisionId={selectedRevisionId}
            t={t}
          />

          <div className="pt-6">
            {tab === "decision" ? (
              <DecisionTab
                evaluation={evaluation}
                history={revisionHistory}
                locale={locale}
                t={t}
              />
            ) : null}
            {tab === "request" ? (
              <RequestTab evaluation={evaluation} locale={locale} t={t} />
            ) : null}
            {tab === "revisions" ? (
              <PolicyRevisionExplorer
                history={revisionHistory}
                selectedRevisionId={selectedRevisionId}
                baseHref={detailBaseHref}
                searchParams={detailSearchParams(filters, "revisions")}
                locale={locale}
                t={t}
              />
            ) : null}
          </div>
        </main>

        {tab !== "revisions" ? (
          <EvaluationContextRail
            wallet={wallet}
            evaluation={evaluation}
            history={revisionHistory}
            apiKeyNames={apiKeyNames}
            policyHref={policyHref}
            t={t}
          />
        ) : null}
      </div>
    </div>
  );
}

function DetailTabs({
  activeTab,
  detailBaseHref,
  filters,
  selectedRevisionId,
  t,
}: {
  activeTab: PolicyAuditDetailTab;
  detailBaseHref: string;
  filters: PolicyAuditFilters;
  selectedRevisionId?: string;
  t: PolicyTranslate;
}) {
  const tabs: Array<{ id: PolicyAuditDetailTab; label: string }> = [
    { id: "decision", label: t("DashboardCustody.policyAuditDecision") },
    { id: "request", label: t("DashboardCustody.policyAuditRequest") },
    { id: "revisions", label: t("DashboardCustody.policyAuditRevisions") },
  ];

  return (
    <nav
      className="flex gap-8 border-b border-border-default"
      aria-label={t("DashboardCustody.policyAuditDetailTabs")}
    >
      {tabs.map((item) => {
        return (
          <Link
            key={item.id}
            href={detailTabHref(detailBaseHref, filters, item.id, selectedRevisionId)}
            aria-current={activeTab === item.id ? "page" : undefined}
            className={`border-b-2 px-1 pb-3 text-sm transition-colors ${
              activeTab === item.id
                ? "border-primary text-primary"
                : "border-transparent text-secondary hover:text-primary"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function DecisionTab({
  evaluation,
  history,
  locale,
  t,
}: {
  evaluation: WalletPolicyEvaluationDetail;
  history: WalletControlProfileRevisionHistory;
  locale: string;
  t: PolicyTranslate;
}) {
  const steps = evaluationSteps(evaluation, t);
  const appliedRevisionId = evaluation.policyRevisions.wallet.evaluatedRevisionId;
  const activeRevisionId =
    history.profile?.activeRevisionId ??
    history.revisions.find((revision) => revision.isActive)?.id ??
    null;
  const revisionChanged = appliedRevisionId !== activeRevisionId;

  return (
    <div className="space-y-6">
      <section className="border-y border-border-default">
        <div className="border-b border-border-default px-5 py-4">
          <h3 className="text-sm font-medium text-primary">
            {t("DashboardCustody.policyAuditDecision")}
          </h3>
          <p className="mt-1 text-sm text-secondary">
            {t("DashboardCustody.policyAuditEvaluationSequence")}
          </p>
        </div>
        <ol className="divide-y divide-border-default px-5">
          {steps.map((step, index) => (
            <li
              key={step.label}
              className="grid gap-3 py-4 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-start"
            >
              <div className="flex items-center gap-2 sm:block">
                <StepIcon decision={step.decision} />
                <span className="mt-2 inline-flex size-6 items-center justify-center rounded-full bg-fill text-xs text-primary sm:flex">
                  {index + 1}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary">{step.label}</p>
                <p className="mt-1 break-words text-sm leading-5 text-secondary">{step.summary}</p>
                {step.details ? <RawDetails value={step.details} t={t} /> : null}
              </div>
              <div className="sm:pt-0.5">
                {step.decision ? (
                  <DecisionBadge decision={step.decision} t={t} />
                ) : (
                  <Badge>{step.outcome}</Badge>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-y border-border-default px-1 py-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <RevisionComparison
            label={t("DashboardCustody.policyAuditAppliedRevisionAtEvaluation")}
            revisionId={appliedRevisionId}
            value={formatRevisionReference(
              history,
              appliedRevisionId,
              t("DashboardCustody.policyAuditDefaultAllow")
            )}
            t={t}
          />
          <RevisionComparison
            label={t("DashboardCustody.policyAuditCurrentlyActiveRevision")}
            revisionId={activeRevisionId}
            value={formatRevisionReference(
              history,
              activeRevisionId,
              t("DashboardCustody.policyAuditNoActiveRevision")
            )}
            t={t}
          />
        </div>
        {revisionChanged ? (
          <p className="mt-5 border-t border-border-default pt-4 text-sm text-warning">
            {t("DashboardCustody.policyAuditHistoricalRevisionNotice")}
          </p>
        ) : null}
        {evaluation.evaluationContext?.apiKeyPolicy ? (
          <div className="mt-5 grid gap-5 border-t border-border-default pt-5 sm:grid-cols-2">
            <RevisionComparison
              label={t("DashboardCustody.policyAuditApiKeyAppliedRevision")}
              revisionId={evaluation.policyRevisions.apiKey.evaluatedRevisionId}
              value={
                evaluation.policyRevisions.apiKey.evaluatedRevisionId
                  ? shortIdentifier(evaluation.policyRevisions.apiKey.evaluatedRevisionId)
                  : t("DashboardCustody.policyAuditNoAdditionalRestriction")
              }
              t={t}
            />
            <RevisionComparison
              label={t("DashboardCustody.policyAuditApiKeyActiveRevision")}
              revisionId={evaluation.policyRevisions.apiKey.activeRevisionId}
              value={
                evaluation.policyRevisions.apiKey.activeRevisionId
                  ? shortIdentifier(evaluation.policyRevisions.apiKey.activeRevisionId)
                  : t("DashboardCustody.policyAuditNoActiveRevision")
              }
              t={t}
            />
          </div>
        ) : null}
        <p className="mt-4 text-xs text-tertiary">
          {t("DashboardCustody.policyAuditEvaluatedAt", {
            date: formatPolicyDateTime(evaluation.evaluatedAt, locale),
          })}
        </p>
      </section>
    </div>
  );
}

interface EvaluationStep {
  label: string;
  summary: string;
  details?: unknown;
  decision?: PolicyDecision;
  outcome?: string;
}

function evaluationSteps(
  evaluation: WalletPolicyEvaluationDetail,
  t: PolicyTranslate
): EvaluationStep[] {
  const context = evaluation.evaluationContext;
  const steps: EvaluationStep[] = [
    {
      label: t("DashboardCustody.policyAuditWalletPolicyEvaluation"),
      summary: context
        ? summarizeRecord(
            {
              source: context.walletPolicy.source,
              defaultAction: context.walletPolicy.defaultAction,
              requiresApproval: context.walletPolicy.requiresApproval,
            },
            t
          )
        : formatDisplayLabel(evaluation.reasonCode),
      details: context?.walletPolicy,
      decision: context?.walletPolicy.decision ?? evaluation.decision,
    },
  ];

  if (context?.apiKeyPolicy) {
    steps.push({
      label: t("DashboardCustody.policyAuditApiKeyPolicyEvaluation"),
      summary: summarizeRecord(
        {
          source: context.apiKeyPolicy.source,
          defaultAction: context.apiKeyPolicy.defaultAction,
          requiresApproval: context.apiKeyPolicy.requiresApproval,
        },
        t
      ),
      details: context.apiKeyPolicy,
      decision: context.apiKeyPolicy.decision,
    });
  }

  const matchedRule = evaluation.matchedRules[0];
  steps.push({
    label: t("DashboardCustody.policyAuditMatchedRule"),
    summary: matchedRule
      ? backendDescription(matchedRule, t)
      : formatDisplayLabel(evaluation.reasonCode),
    details: matchedRule,
    decision: matchedRule
      ? (decisionFromRecord(matchedRule) ?? evaluation.decision)
      : evaluation.decision,
  });

  const observed = observedContext(evaluation);
  steps.push({
    label: t("DashboardCustody.policyAuditObservedValueContext"),
    summary: summarizeRecord(observed, t),
    details: observed,
    outcome: t("DashboardCustody.policyAuditRecorded"),
  });
  const expectation = effectiveExpectation(evaluation);
  steps.push({
    label: t("DashboardCustody.policyAuditEffectiveLimitExpectation"),
    summary: summarizeRecord(expectation, t),
    details: expectation,
    outcome: t("DashboardCustody.policyAuditApplied"),
  });
  steps.push({
    label: t("DashboardCustody.policyAuditFinalDecision"),
    summary: evaluation.reason ?? formatDisplayLabel(evaluation.reasonCode),
    decision: evaluation.decision,
  });

  return steps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function backendDescription(record: Record<string, unknown>, t: PolicyTranslate): string {
  for (const key of ["description", "reason", "name"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return summarizeRecord(record, t);
}

function summarizeRecord(record: Record<string, unknown>, t: PolicyTranslate): string {
  const entries = Object.entries(record).filter(([, value]) => hasAuditValue(value));
  if (entries.length === 0) return t("DashboardCustody.policyAuditNoRecordedValues");
  return entries
    .slice(0, 5)
    .map(([key, value]) => `${formatAuditFieldLabel(key)}: ${formatSummaryValue(key, value, t)}`)
    .join(" · ");
}

function hasAuditValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function formatSummaryValue(key: string, value: unknown, t: PolicyTranslate): string {
  if (typeof value === "boolean") {
    return value ? t("DashboardCustody.policyAuditYes") : t("DashboardCustody.policyAuditNo");
  }
  if (Array.isArray(value)) {
    return value.length > 0
      ? value
          .map((item) =>
            shouldFormatAuditValue(key) ? formatDisplayLabel(String(item)) : String(item)
          )
          .join(", ")
      : t("DashboardCustody.policyAuditNone");
  }
  if (isRecord(value)) {
    if (key === "actor") {
      const actorType = typeof value.type === "string" ? formatDisplayLabel(value.type) : null;
      const actorId = typeof value.id === "string" ? shortIdentifier(value.id) : null;
      return [actorType, actorId].filter(Boolean).join(" · ");
    }
    return summarizeRecord(value, t);
  }
  const text = String(value);
  if (shouldFormatAuditValue(key)) {
    return formatDisplayLabel(text);
  }
  return text.length > 48 ? shortIdentifier(text, 10) : text;
}

function shouldFormatAuditValue(key: string): boolean {
  return [
    "source",
    "defaultAction",
    "decision",
    "status",
    "family",
    "families",
    "kind",
    "action",
    "type",
    "operationFamily",
    "operationType",
    "operationTypes",
  ].includes(key);
}

function formatAuditFieldLabel(key: string): string {
  return formatDisplayLabel(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

function decisionFromRecord(record: Record<string, unknown>): PolicyDecision | null {
  const value = record.decision ?? record.action;
  return [
    "allow",
    "deny",
    "approval_required",
    "provider_approval_required",
    "review",
    "not_evaluated",
  ].includes(String(value))
    ? (value as PolicyDecision)
    : null;
}

function observedContext(evaluation: WalletPolicyEvaluationDetail): Record<string, unknown> {
  const operation = evaluation.evaluationContext?.operation;
  return {
    asset: operation?.asset ?? evaluation.walletOperation.asset,
    amount: operation?.amount ?? evaluation.walletOperation.amount,
    destination: operation?.destination ?? evaluation.walletOperation.destination,
    context: operation?.context ?? null,
  };
}

function effectiveExpectation(evaluation: WalletPolicyEvaluationDetail): Record<string, unknown> {
  const keys = [
    "min",
    "max",
    "allowlist",
    "blocklist",
    "destination",
    "destinations",
    "family",
    "families",
    "operationType",
    "operationTypes",
    "asset",
    "assets",
    "approvalGroupId",
  ];
  const expectation: Record<string, unknown> = {};
  for (const matchedRule of evaluation.matchedRules) {
    const rule = isRecord(matchedRule.rule) ? matchedRule.rule : matchedRule;
    for (const key of keys) {
      if (rule[key] !== undefined) expectation[key] = rule[key];
    }
  }
  if (Object.keys(expectation).length > 0) return expectation;
  return {
    defaultAction: evaluation.evaluationContext?.walletPolicy.defaultAction ?? evaluation.decision,
  };
}

function StepIcon({ decision }: { decision?: PolicyDecision }) {
  const className = "size-5";
  if (decision === "allow") {
    return (
      <span className="inline-flex size-7 items-center justify-center rounded-full bg-success-bg text-success">
        <Check className={className} />
      </span>
    );
  }
  if (decision === "deny") {
    return (
      <span className="inline-flex size-7 items-center justify-center rounded-full bg-error-bg text-error">
        <X className={className} />
      </span>
    );
  }
  if (
    decision === "approval_required" ||
    decision === "provider_approval_required" ||
    decision === "review"
  ) {
    return (
      <span className="inline-flex size-7 items-center justify-center rounded-full bg-warning-bg text-warning">
        <Clock3 className={className} />
      </span>
    );
  }
  return (
    <span className="inline-flex size-7 items-center justify-center rounded-full bg-fill text-secondary">
      <CircleMinus className={className} />
    </span>
  );
}

function RevisionComparison({
  label,
  revisionId,
  value,
  t,
}: {
  label: string;
  revisionId: string | null;
  value: string;
  t: PolicyTranslate;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-secondary">{label}</p>
      <div className="mt-1 flex items-center gap-1">
        <p className="truncate text-sm font-medium text-primary" title={revisionId ?? undefined}>
          {value}
        </p>
        {revisionId ? (
          <WalletMetadataCopyButton
            value={revisionId}
            label={t("DashboardCustody.policyAuditRevisionId")}
          />
        ) : null}
      </div>
    </div>
  );
}

function RequestTab({
  evaluation,
  locale,
  t,
}: {
  evaluation: WalletPolicyEvaluationDetail;
  locale: string;
  t: PolicyTranslate;
}) {
  const requestId = requestIdFromEvaluation(evaluation);
  const apiKeyId = evaluation.evaluationContext?.operation.apiKeyId ?? null;
  if (!evaluation.evaluationContext) {
    return (
      <div className="border-y border-border-default py-16 text-center">
        <p className="text-sm font-medium text-primary">
          {t("DashboardCustody.policyAuditLegacyContextEmpty")}
        </p>
      </div>
    );
  }

  const context = evaluation.evaluationContext;

  return (
    <section className="space-y-5">
      <div className="grid gap-4 border-y border-border-default py-5 sm:grid-cols-2 xl:grid-cols-4">
        <CopyableId label={t("DashboardCustody.policyAuditEvaluationId")} value={evaluation.id} />
        <CopyableId
          label={t("DashboardCustody.policyAuditOperationId")}
          value={evaluation.walletOperation.id}
        />
        {requestId ? (
          <CopyableId label={t("DashboardCustody.policyAuditRequestId")} value={requestId} />
        ) : null}
        {apiKeyId ? (
          <CopyableId label={t("DashboardCustody.policyAuditApiKeyId")} value={apiKeyId} />
        ) : null}
      </div>
      <div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardCustody.policyAuditRequestContext")}
            </h3>
            <p className="mt-1 text-sm text-secondary">
              {t("DashboardCustody.policyAuditRedactedContext")}
            </p>
          </div>
          <span className="text-xs text-tertiary">
            {formatPolicyDateTime(evaluation.evaluatedAt, locale)}
          </span>
        </div>
        <div className="mt-4 border-y border-border-default">
          <ContextSection
            title={t("DashboardCustody.policyAuditOperation")}
            values={{
              operationFamily: context.operation.operationFamily,
              operationType: context.operation.operationType,
              asset: context.operation.asset,
              amount: context.operation.amount,
              destination: context.operation.destination,
              source: context.operation.source,
              actor: context.operation.actor,
            }}
            t={t}
          />
          <ContextSection
            title={t("DashboardCustody.policyAuditWalletPolicyEvaluation")}
            values={context.walletPolicy}
            t={t}
          />
          {context.apiKeyPolicy ? (
            <ContextSection
              title={t("DashboardCustody.policyAuditApiKeyPolicyEvaluation")}
              values={context.apiKeyPolicy}
              t={t}
            />
          ) : null}
        </div>
        <RawDetails value={context} t={t} />
      </div>
    </section>
  );
}

function CopyableId({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-secondary">{label}</p>
      <div className="mt-1 flex items-center gap-1">
        <p className="truncate text-sm text-primary" title={value}>
          {shortIdentifier(value)}
        </p>
        <WalletMetadataCopyButton value={value} label={label} />
      </div>
    </div>
  );
}

function ContextSection({
  title,
  values,
  t,
}: {
  title: string;
  values: object;
  t: PolicyTranslate;
}) {
  const entries = Object.entries(values).filter(([, value]) => hasAuditValue(value));
  return (
    <section className="py-5 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border-default">
      <h4 className="text-sm font-medium text-primary">{title}</h4>
      {entries.length > 0 ? (
        <dl className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs text-tertiary">{formatAuditFieldLabel(key)}</dt>
              <dd className="mt-1 break-words text-sm text-primary">
                {formatSummaryValue(key, value, t)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-secondary">
          {t("DashboardCustody.policyAuditNoRecordedValues")}
        </p>
      )}
    </section>
  );
}

function RawDetails({ value, t }: { value: unknown; t: PolicyTranslate }) {
  return (
    <details className="group/raw mt-3">
      <summary className="w-fit cursor-pointer list-none text-xs text-secondary transition-colors hover:text-primary">
        {t("DashboardCustody.policyAuditRawDetails")}
        <ArrowRight className="ml-1 inline size-3 transition-transform group-open/raw:rotate-90" />
      </summary>
      <pre className="mt-3 max-h-[420px] overflow-auto rounded-md bg-surface-sunken p-4 text-xs leading-5 text-primary">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function EvaluationContextRail({
  wallet,
  evaluation,
  history,
  apiKeyNames,
  policyHref,
  t,
}: {
  wallet: CustodyWalletMetadataResponse["wallet"];
  evaluation: WalletPolicyEvaluationDetail;
  history: WalletControlProfileRevisionHistory;
  apiKeyNames: Record<string, string>;
  policyHref: string;
  t: PolicyTranslate;
}) {
  const operation = evaluation.evaluationContext?.operation;
  const apiKeyId = operation?.apiKeyId ?? null;
  const actor = policyActor(evaluation, apiKeyNames);
  const requestId = requestIdFromEvaluation(evaluation);
  const activeRevisionId =
    history.profile?.activeRevisionId ??
    history.revisions.find((revision) => revision.isActive)?.id ??
    null;

  return (
    <aside className="h-fit border-t border-border-default pt-5 xl:sticky xl:top-4 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6">
      <h2 className="text-base font-medium text-primary">
        {t("DashboardCustody.policyAuditEvaluationContext")}
      </h2>
      <dl className="mt-3 divide-y divide-border-default border-y border-border-default">
        <ContextRow icon={<WalletCards className="size-4" />} label={t("DashboardCustody.wallet")}>
          {walletLabel(wallet)}
        </ContextRow>
        {apiKeyId ? (
          <ContextRow
            icon={<KeyRound className="size-4" />}
            label={t("DashboardCustody.policyAuditApiKey")}
          >
            {apiKeyNames[apiKeyId] ?? shortIdentifier(apiKeyId)}
          </ContextRow>
        ) : null}
        {actor.type !== "api_key" && actor.value ? (
          <ContextRow
            icon={<UserRound className="size-4" />}
            label={t("DashboardCustody.policyAuditActor")}
          >
            <span
              className="block truncate"
              data-policy-audit-detail-rail-actor
              title={actor.value}
            >
              {actor.value}
            </span>
          </ContextRow>
        ) : null}
        <ContextRow
          icon={<ShieldCheck className="size-4" />}
          label={t("DashboardCustody.policyAuditAppliedRevision")}
        >
          {formatRevisionReference(
            history,
            evaluation.policyRevisions.wallet.evaluatedRevisionId,
            t("DashboardCustody.policyAuditDefaultAllow")
          )}
        </ContextRow>
        <ContextRow
          icon={<ShieldCheck className="size-4" />}
          label={t("DashboardCustody.policyAuditActiveRevision")}
        >
          {formatRevisionReference(
            history,
            activeRevisionId,
            t("DashboardCustody.policyAuditNoActiveRevision")
          )}
        </ContextRow>
        {evaluation.approvalRequestId ? (
          <ContextRow
            icon={<Clock3 className="size-4" />}
            label={t("DashboardCustody.policyAuditApprovalRequest")}
          >
            {shortIdentifier(evaluation.approvalRequestId)}
          </ContextRow>
        ) : null}
        {requestId ? (
          <ContextRow
            icon={<FileKey className="size-4" />}
            label={t("DashboardCustody.policyAuditRequestId")}
          >
            <span className="flex min-w-0 items-center justify-end gap-1">
              <span className="truncate" title={requestId}>
                {shortIdentifier(requestId)}
              </span>
              <WalletMetadataCopyButton
                value={requestId}
                label={t("DashboardCustody.policyAuditRequestId")}
              />
            </span>
          </ContextRow>
        ) : null}
      </dl>

      <div className="mt-4 space-y-2">
        <RailAction href={policyHref} label={t("DashboardCustody.policyAuditViewWalletControls")} />
        {apiKeyId && apiKeyNames[apiKeyId] ? (
          <RailAction
            href={`/dashboard/api-keys?apiKeyId=${encodeURIComponent(apiKeyId)}`}
            label={t("DashboardCustody.policyAuditViewApiKey")}
          />
        ) : null}
        {evaluation.approvalRequestId ? (
          <RailAction
            href={`/dashboard/approvals/${encodeURIComponent(evaluation.approvalRequestId)}`}
            label={t("DashboardCustody.policyAuditViewApprovalRequest")}
          />
        ) : null}
      </div>
    </aside>
  );
}

function ContextRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-center gap-3 py-3 text-sm">
      <dt className="flex items-center gap-2 text-secondary">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0 text-right text-primary">{children}</dd>
    </div>
  );
}

function RailAction({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="outline" className="w-full justify-between">
      <Link href={href}>
        {label}
        <ExternalLink className="size-4" />
      </Link>
    </Button>
  );
}

function MetadataLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <span className="shrink-0">{icon}</span>
      {children}
    </span>
  );
}

function NeighborButton({
  direction,
  neighbor,
  href,
  t,
}: {
  direction: "previous" | "next";
  neighbor: PolicyAuditNeighbor | null;
  href: string;
  t: PolicyTranslate;
}) {
  const label =
    direction === "previous"
      ? t("DashboardCustody.policyAuditPrevious")
      : t("DashboardCustody.policyAuditNext");
  const icon =
    direction === "previous" ? <ArrowLeft className="size-4" /> : <ArrowRight className="size-4" />;
  if (!neighbor) {
    return (
      <Button type="button" variant="outline" size="sm" disabled>
        {direction === "previous" ? icon : null}
        {label}
        {direction === "next" ? icon : null}
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>
        {direction === "previous" ? icon : null}
        {label}
        {direction === "next" ? icon : null}
      </Link>
    </Button>
  );
}

function walletLabel(wallet: CustodyWalletMetadataResponse["wallet"]): string {
  return wallet.label?.trim() || wallet.walletId;
}

function detailSearchParams(
  filters: PolicyAuditFilters,
  tab: PolicyAuditDetailTab
): URLSearchParams {
  const query = buildPolicyAuditSearchParams(filters);
  query.set("tab", tab);
  return query;
}

function detailTabHref(
  detailBaseHref: string,
  filters: PolicyAuditFilters,
  tab: PolicyAuditDetailTab,
  selectedRevisionId?: string
): string {
  const query = detailSearchParams(filters, tab);
  if (tab === "revisions" && selectedRevisionId) query.set("revision", selectedRevisionId);
  return `${detailBaseHref}?${query}`;
}

function neighborHref(
  currentDetailBaseHref: string,
  neighbor: PolicyAuditNeighbor | null,
  filters: PolicyAuditFilters,
  tab: PolicyAuditDetailTab,
  selectedRevisionId?: string
): string {
  if (!neighbor) return currentDetailBaseHref;
  const auditBase = currentDetailBaseHref.slice(0, currentDetailBaseHref.lastIndexOf("/"));
  const query = detailSearchParams({ ...filters, page: neighbor.page }, tab);
  if (selectedRevisionId && tab === "revisions") query.set("revision", selectedRevisionId);
  return `${auditBase}/${encodeURIComponent(neighbor.id)}?${query}`;
}
