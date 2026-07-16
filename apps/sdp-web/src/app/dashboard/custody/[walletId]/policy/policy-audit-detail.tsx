import type {
  CustodyWalletByIdResponse,
  PolicyDecision,
  WalletControlProfileRevisionHistory,
  WalletPolicyEvaluationDetail,
} from "@sdp/types";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
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
import Link from "next/link";
import type { ReactNode } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
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
  PolicyPageHeader,
  type PolicyTranslate,
  policyActor,
  providerMappingState,
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
  wallet: CustodyWalletByIdResponse["wallet"];
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
      <PolicyPageHeader
        backHref={backHref}
        backLabel={t("DashboardCustody.policyAuditBackToAudit")}
        title={t("DashboardCustody.policyAuditTitle")}
        trailing={
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
        }
      />

      <section>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-medium text-primary sm:text-3xl">
            {decisionHeading(evaluation.decision, t)}
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
              {actor.type === "api_key" && !actor.name
                ? t("DashboardCustody.policyAuditUnavailableApiKey")
                : actor.value}
            </MetadataLine>
          ) : null}
        </div>
      </section>

      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
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

        <EvaluationContextRail
          wallet={wallet}
          evaluation={evaluation}
          history={revisionHistory}
          apiKeyNames={apiKeyNames}
          policyHref={policyHref}
          t={t}
        />
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
  const activeRevisionId = evaluation.policyRevisions.wallet.activeRevisionId;
  const revisionChanged = appliedRevisionId !== activeRevisionId;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-lg border border-border-default bg-white">
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
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-secondary">
                  {step.description}
                </p>
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

      <section className="rounded-lg border border-border-default bg-white p-5">
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
  description: string;
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
      description: context ? policyContextDescription(context.walletPolicy) : evaluation.reasonCode,
      decision: context?.walletPolicy.decision ?? evaluation.decision,
    },
  ];

  if (context?.apiKeyPolicy) {
    steps.push({
      label: t("DashboardCustody.policyAuditApiKeyPolicyEvaluation"),
      description: policyContextDescription(context.apiKeyPolicy),
      decision: context.apiKeyPolicy.decision,
    });
  }

  const matchedRule = evaluation.matchedRules[0];
  steps.push({
    label: t("DashboardCustody.policyAuditMatchedRule"),
    description: matchedRule ? backendDescription(matchedRule) : evaluation.reasonCode,
    decision: matchedRule
      ? (decisionFromRecord(matchedRule) ?? evaluation.decision)
      : evaluation.decision,
  });

  steps.push({
    label: t("DashboardCustody.policyAuditObservedValueContext"),
    description: JSON.stringify(observedContext(evaluation), null, 2),
    outcome: t("DashboardCustody.policyAuditRecorded"),
  });
  steps.push({
    label: t("DashboardCustody.policyAuditEffectiveLimitExpectation"),
    description: JSON.stringify(effectiveExpectation(evaluation), null, 2),
    outcome: t("DashboardCustody.policyAuditApplied"),
  });
  steps.push({
    label: t("DashboardCustody.policyAuditFinalDecision"),
    description: evaluation.reason ?? evaluation.reasonCode,
    decision: evaluation.decision,
  });

  return steps;
}

function policyContextDescription(context: {
  source: string;
  revisionId: string | null;
  defaultAction: string;
  decision: string;
  requiresApproval: boolean;
}): string {
  return JSON.stringify(
    {
      source: context.source,
      revisionId: context.revisionId,
      defaultAction: context.defaultAction,
      decision: context.decision,
      requiresApproval: context.requiresApproval,
    },
    null,
    2
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function backendDescription(record: Record<string, unknown>): string {
  for (const key of ["description", "reason", "name"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return JSON.stringify(record, null, 2);
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
        <pre className="mt-4 max-h-[620px] overflow-auto rounded-lg border border-border-default bg-surface-sunken p-5 text-xs leading-5 text-primary">
          {JSON.stringify(evaluation.evaluationContext, null, 2)}
        </pre>
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

function EvaluationContextRail({
  wallet,
  evaluation,
  history,
  apiKeyNames,
  policyHref,
  t,
}: {
  wallet: CustodyWalletByIdResponse["wallet"];
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
  const mapping = providerMappingState(evaluation);
  const mappingLabel = {
    pending: t("DashboardCustody.policyAuditProviderPending"),
    partial: t("DashboardCustody.policyAuditProviderPartial"),
    failed: t("DashboardCustody.policyAuditProviderFailed"),
    provider_approval: t("DashboardCustody.policyAuditProviderApproval"),
    sdp_enforced: t("DashboardCustody.policyAuditSdpEnforced"),
  }[mapping];

  return (
    <aside className="h-fit rounded-lg border border-border-default bg-white p-5 xl:sticky xl:top-4">
      <h2 className="text-base font-medium text-primary">
        {t("DashboardCustody.policyAuditEvaluationContext")}
      </h2>
      <dl className="mt-4 divide-y divide-border-default border-y border-border-default">
        <ContextRow icon={<WalletCards className="size-4" />} label={t("DashboardCustody.wallet")}>
          {walletLabel(wallet)}
        </ContextRow>
        <ContextRow
          icon={<KeyRound className="size-4" />}
          label={t("DashboardCustody.policyAuditApiKey")}
        >
          {apiKeyId
            ? (apiKeyNames[apiKeyId] ?? t("DashboardCustody.policyAuditUnavailableApiKey"))
            : t("DashboardCustody.policyAuditUnavailable")}
        </ContextRow>
        <ContextRow
          icon={<UserRound className="size-4" />}
          label={t("DashboardCustody.policyAuditActor")}
        >
          {actor.type === "api_key"
            ? formatDisplayLabel(operation?.actor?.type ?? "api_key")
            : actor.value || t("DashboardCustody.policyAuditUnavailable")}
        </ContextRow>
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
            evaluation.policyRevisions.wallet.activeRevisionId,
            t("DashboardCustody.policyAuditNoActiveRevision")
          )}
        </ContextRow>
        <ContextRow
          icon={<ShieldCheck className="size-4" />}
          label={t("DashboardCustody.policyAuditProviderMapping")}
        >
          <Badge
            variant={
              mapping === "failed"
                ? "danger"
                : mapping === "partial" || mapping === "pending"
                  ? "warning"
                  : "default"
            }
          >
            {mappingLabel}
          </Badge>
        </ContextRow>
        <ContextRow
          icon={<Clock3 className="size-4" />}
          label={t("DashboardCustody.policyAuditApprovalRequest")}
        >
          {evaluation.approvalRequestId
            ? shortIdentifier(evaluation.approvalRequestId)
            : t("DashboardCustody.policyAuditUnavailable")}
        </ContextRow>
        <ContextRow
          icon={<FileKey className="size-4" />}
          label={t("DashboardCustody.policyAuditRequestId")}
        >
          {requestId ? (
            <span className="flex min-w-0 items-center justify-end gap-1">
              <span className="truncate" title={requestId}>
                {shortIdentifier(requestId)}
              </span>
              <WalletMetadataCopyButton
                value={requestId}
                label={t("DashboardCustody.policyAuditRequestId")}
              />
            </span>
          ) : (
            t("DashboardCustody.policyAuditUnavailable")
          )}
        </ContextRow>
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
    <span className="inline-flex items-center gap-2">
      {icon}
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

function walletLabel(wallet: CustodyWalletByIdResponse["wallet"]): string {
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
