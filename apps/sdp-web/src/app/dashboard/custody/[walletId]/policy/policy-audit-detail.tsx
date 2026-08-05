import type {
  CustodyWalletMetadataResponse,
  PolicyDecision,
  WalletControlProfileRevisionHistory,
  WalletPolicyEvaluationDetail,
} from "@sdp/types";
import { Tab, TabList, TabPanel, Tabs } from "@solana/design-system/tabs";
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleMinus,
  Clock3,
  ExternalLink,
  FileKey,
  Hash,
  History,
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
import { UserAvatar } from "@/components/user-avatar";
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
  revisionNumber,
  shortIdentifier,
} from "./policy-audit.shared";
import { PolicyAuditRawDetails } from "./policy-audit-raw-details";
import { RevisionHistoryDrawer } from "./revision-history-drawer";

export function PolicyAuditDetail({
  wallet,
  evaluation,
  revisionHistory,
  apiKeyNames,
  userNames,
  neighbors,
  filters,
  locale,
  t,
}: {
  wallet: CustodyWalletMetadataResponse["wallet"];
  evaluation: WalletPolicyEvaluationDetail;
  revisionHistory: WalletControlProfileRevisionHistory;
  apiKeyNames: Record<string, string>;
  userNames: Record<string, string>;
  neighbors: PolicyAuditNeighbors;
  filters: PolicyAuditFilters;
  locale: string;
  t: PolicyTranslate;
}) {
  const encodedWalletId = encodeURIComponent(wallet.walletId);
  const policyHref = `/dashboard/wallets/${encodedWalletId}/policy`;
  const auditHref = `${policyHref}/audit`;
  const detailBaseHref = `${auditHref}/${encodeURIComponent(evaluation.id)}`;
  const actor = policyActor(evaluation, apiKeyNames, userNames);
  const requestId = requestIdFromEvaluation(evaluation);

  return (
    <div className="w-full space-y-6">
      <section>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-medium text-primary sm:text-3xl">
            {decisionHeading(evaluation)}
          </h2>
          <DecisionBadge decision={evaluation.decision} t={t} />
          <div className="ml-auto flex items-center gap-2">
            <NeighborButton
              direction="previous"
              href={
                neighbors.previous
                  ? neighborHref(detailBaseHref, neighbors.previous, filters)
                  : null
              }
              label={t("DashboardCustody.policyAuditPrevious")}
            />
            <NeighborButton
              direction="next"
              href={neighbors.next ? neighborHref(detailBaseHref, neighbors.next, filters) : null}
              label={t("DashboardCustody.policyAuditNext")}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-secondary">
          <MetadataLine icon={<CalendarClock className="size-4" />}>
            {formatPolicyDateTime(evaluation.evaluatedAt, locale)}
          </MetadataLine>
          <MetadataLine
            icon={<WalletCards className="size-4" />}
            label={t("DashboardCustody.wallet")}
          >
            {walletLabel(wallet)}
          </MetadataLine>
          {requestId ? (
            <MetadataLine
              icon={<FileKey className="size-4" />}
              label={t("DashboardCustody.policyAuditRequestId")}
            >
              <span>{shortIdentifier(requestId)}</span>
              <WalletMetadataCopyButton
                value={requestId}
                label={t("DashboardCustody.policyAuditRequestId")}
              />
            </MetadataLine>
          ) : null}
          <MetadataLine
            icon={<Hash className="size-4" />}
            label={t("DashboardCustody.policyAuditEvaluationId")}
          >
            <span title={evaluation.id}>{shortIdentifier(evaluation.id)}</span>
            <WalletMetadataCopyButton
              value={evaluation.id}
              label={t("DashboardCustody.policyAuditEvaluationId")}
            />
          </MetadataLine>
          <MetadataLine
            icon={<Hash className="size-4" />}
            label={t("DashboardCustody.policyAuditOperationId")}
          >
            <span title={evaluation.walletOperation.id}>
              {shortIdentifier(evaluation.walletOperation.id)}
            </span>
            <WalletMetadataCopyButton
              value={evaluation.walletOperation.id}
              label={t("DashboardCustody.policyAuditOperationId")}
            />
          </MetadataLine>
          {actor.value ? (
            <MetadataLine
              icon={
                actor.type === "api_key" ? (
                  <KeyRound className="size-4" />
                ) : actor.name ? (
                  <UserAvatar name={actor.name} className="size-5 text-[9px]" />
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
              {actor.id ? (
                <WalletMetadataCopyButton
                  value={actor.id}
                  label={t(
                    actor.type === "api_key"
                      ? "DashboardCustody.policyAuditApiKeyId"
                      : "DashboardCustody.policyAuditUserId"
                  )}
                />
              ) : null}
            </MetadataLine>
          ) : null}
        </div>
      </section>

      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_460px]">
        <main className="min-w-0">
          <DecisionTab evaluation={evaluation} t={t} />
        </main>

        <EvaluationContextRail
          wallet={wallet}
          evaluation={evaluation}
          history={revisionHistory}
          apiKeyNames={apiKeyNames}
          userNames={userNames}
          policyHref={policyHref}
          t={t}
        />
      </div>
    </div>
  );
}

function DecisionTab({
  evaluation,
  t,
}: {
  evaluation: WalletPolicyEvaluationDetail;
  t: PolicyTranslate;
}) {
  const steps = evaluationSteps(evaluation, t);

  return (
    <div className="space-y-6">
      <section>
        <ol className="space-y-3">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className="grid gap-3 rounded-lg border border-border-default bg-surface-raised p-5 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-start"
            >
              <div className="flex items-center gap-2 sm:block">
                <StepIcon decision={step.decision} />
                <span className="mt-2 inline-flex size-7 items-center justify-center rounded-full bg-fill text-xs text-primary sm:flex">
                  {index + 1}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary">{step.label}</p>
                <p className="mt-1 break-words text-sm leading-5 text-secondary">{step.summary}</p>
                {step.details ? (
                  <PolicyAuditRawDetails
                    value={step.details}
                    label={t("DashboardCustody.policyAuditRawDetails")}
                    filename={`${step.id}.json`}
                  />
                ) : null}
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
    </div>
  );
}

interface EvaluationStep {
  id: string;
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
      id: "wallet-policy",
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
      id: "api-key-policy",
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
    id: "matched-rule",
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
    id: "observed-context",
    label: t("DashboardCustody.policyAuditObservedValueContext"),
    summary: summarizeRecord(observed, t),
    details: observed,
    outcome: t("DashboardCustody.policyAuditRecorded"),
  });
  const expectation = effectiveExpectation(evaluation);
  steps.push({
    id: "effective-expectation",
    label: t("DashboardCustody.policyAuditEffectiveLimitExpectation"),
    summary: summarizeRecord(expectation, t),
    details: expectation,
    outcome: t("DashboardCustody.policyAuditApplied"),
  });
  steps.push({
    id: "final-decision",
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

function RevisionValue({
  revisionId,
  value,
  t,
}: {
  revisionId: string | null;
  value: string;
  t: PolicyTranslate;
}) {
  return (
    <span className="flex min-w-0 items-center justify-end gap-1">
      <span
        className={revisionId ? "truncate" : "truncate italic text-secondary"}
        title={revisionId ?? undefined}
      >
        {value}
      </span>
      {revisionId ? (
        <WalletMetadataCopyButton
          value={revisionId}
          label={t("DashboardCustody.policyAuditRevisionId")}
        />
      ) : null}
    </span>
  );
}

function ContextFields({ values, t }: { values: object; t: PolicyTranslate }) {
  const entries = Object.entries(values).filter(([, value]) => hasAuditValue(value));
  if (entries.length === 0) {
    return (
      <p className="py-3 text-sm text-secondary">
        {t("DashboardCustody.policyAuditNoRecordedValues")}
      </p>
    );
  }
  return (
    <dl className="divide-y divide-border-default">
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 py-3 text-sm"
        >
          <dt className="text-secondary">{formatAuditFieldLabel(key)}</dt>
          <dd className="min-w-0 break-words text-right text-primary">
            {formatSummaryValue(key, value, t)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EvaluationContextRail({
  wallet,
  evaluation,
  history,
  apiKeyNames,
  userNames,
  policyHref,
  t,
}: {
  wallet: CustodyWalletMetadataResponse["wallet"];
  evaluation: WalletPolicyEvaluationDetail;
  history: WalletControlProfileRevisionHistory;
  apiKeyNames: Record<string, string>;
  userNames: Record<string, string>;
  policyHref: string;
  t: PolicyTranslate;
}) {
  const operation = evaluation.evaluationContext?.operation;
  const apiKeyId = operation?.apiKeyId ?? null;
  const activeRevisionId =
    history.profile?.activeRevisionId ??
    history.revisions.find((revision) => revision.isActive)?.id ??
    null;
  const activeRevisionNumber = revisionNumber(history, activeRevisionId);
  const appliedRevisionId = evaluation.policyRevisions.wallet.evaluatedRevisionId;
  const revisionChanged = appliedRevisionId !== activeRevisionId;
  const apiKeyRevisionChanged =
    evaluation.policyRevisions.apiKey.evaluatedRevisionId !==
    evaluation.policyRevisions.apiKey.activeRevisionId;

  return (
    <aside className="h-fit rounded-lg border border-border-default bg-surface-raised p-5 xl:sticky xl:top-4">
      <h2 className="text-base font-medium text-primary">
        {t("DashboardCustody.policyAuditEvaluationContext")}
      </h2>
      <Tabs bordered defaultValue="wallet_policy" className="-mx-5 mt-3">
        <TabList className="px-[calc(--spacing(5)-var(--tab-padding-x-md))]">
          <Tab value="wallet_policy">{t("DashboardCustody.policyAuditWalletPolicyTab")}</Tab>
          {evaluation.evaluationContext?.apiKeyPolicy ? (
            <Tab value="api_key_policy">{t("DashboardCustody.policyAuditApiKeyPolicyTab")}</Tab>
          ) : null}
        </TabList>
        <TabPanel value="wallet_policy" className="px-5">
          <dl className="divide-y divide-border-default">
            <ContextRow
              icon={<ShieldCheck className="size-4" />}
              label={t("DashboardCustody.policyAuditAppliedRevision")}
            >
              <RevisionValue
                revisionId={appliedRevisionId}
                value={formatRevisionReference(
                  history,
                  appliedRevisionId,
                  t("DashboardCustody.policyAuditNoRevisionApplied")
                )}
                t={t}
              />
            </ContextRow>
            <ContextRow
              icon={<ShieldCheck className="size-4" />}
              label={t("DashboardCustody.policyAuditActiveRevision")}
            >
              <RevisionValue
                revisionId={activeRevisionId}
                value={formatRevisionReference(
                  history,
                  activeRevisionId,
                  t("DashboardCustody.policyAuditNoActiveRevision")
                )}
                t={t}
              />
            </ContextRow>
          </dl>
          {evaluation.evaluationContext ? (
            <div className="border-t border-border-default">
              <ContextFields values={evaluation.evaluationContext.walletPolicy} t={t} />
            </div>
          ) : null}
          {revisionChanged ? (
            <p className="border-t border-border-default py-3 text-sm text-warning">
              {t("DashboardCustody.policyAuditHistoricalRevisionNotice")}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2 pb-1">
            {activeRevisionId && activeRevisionNumber !== null ? (
              <RevisionHistoryDrawer
                walletId={wallet.walletId}
                preloaded={{ history, userNames }}
                defaultRevisionId={activeRevisionId}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-w-0 flex-1"
                    iconLeft={<History className="size-4" />}
                  >
                    {t("DashboardCustody.policyAuditViewActiveRevision", {
                      number: activeRevisionNumber,
                    })}
                  </Button>
                }
              />
            ) : null}
            <RailAction
              href={policyHref}
              label={t("DashboardCustody.policyAuditViewWalletControls")}
            />
          </div>
        </TabPanel>
        {evaluation.evaluationContext?.apiKeyPolicy ? (
          <TabPanel value="api_key_policy" className="px-5">
            <dl className="divide-y divide-border-default">
              <ContextRow
                icon={<KeyRound className="size-4" />}
                label={t("DashboardCustody.policyAuditApiKeyAppliedRevision")}
              >
                <RevisionValue
                  revisionId={evaluation.policyRevisions.apiKey.evaluatedRevisionId}
                  value={
                    evaluation.policyRevisions.apiKey.evaluatedRevisionId
                      ? shortIdentifier(evaluation.policyRevisions.apiKey.evaluatedRevisionId)
                      : t("DashboardCustody.policyAuditNoAdditionalRestriction")
                  }
                  t={t}
                />
              </ContextRow>
              <ContextRow
                icon={<KeyRound className="size-4" />}
                label={t("DashboardCustody.policyAuditApiKeyActiveRevision")}
              >
                <RevisionValue
                  revisionId={evaluation.policyRevisions.apiKey.activeRevisionId}
                  value={
                    evaluation.policyRevisions.apiKey.activeRevisionId
                      ? shortIdentifier(evaluation.policyRevisions.apiKey.activeRevisionId)
                      : t("DashboardCustody.policyAuditNoActiveRevision")
                  }
                  t={t}
                />
              </ContextRow>
            </dl>
            <div className="border-t border-border-default">
              <ContextFields values={evaluation.evaluationContext.apiKeyPolicy} t={t} />
            </div>
            {apiKeyRevisionChanged ? (
              <p className="border-t border-border-default py-3 text-sm text-warning">
                {t("DashboardCustody.policyAuditHistoricalRevisionNotice")}
              </p>
            ) : null}
            {apiKeyId && apiKeyNames[apiKeyId] ? (
              <div className="mt-3 flex gap-2 pb-1">
                <RailAction
                  href={`/dashboard/api-keys?apiKeyId=${encodeURIComponent(apiKeyId)}`}
                  label={t("DashboardCustody.policyAuditViewApiKey")}
                />
              </div>
            ) : null}
          </TabPanel>
        ) : null}
      </Tabs>

      {evaluation.approvalRequestId ? (
        <div className="mt-4 flex gap-2">
          <RailAction
            href={`/dashboard/approvals/${encodeURIComponent(evaluation.approvalRequestId)}`}
            label={t("DashboardCustody.policyAuditViewApprovalRequest")}
          />
        </div>
      ) : null}

      <div aria-hidden="true" className="-mx-5 mt-4 border-t border-border-default" />
      {evaluation.evaluationContext ? (
        <>
          <p className="mt-3 text-xs text-tertiary">
            {t("DashboardCustody.policyAuditRedactedContext")}
          </p>
          <PolicyAuditRawDetails
            value={evaluation.evaluationContext}
            label={t("DashboardCustody.policyAuditRawDetails")}
            filename={`${evaluation.id}.json`}
          />
        </>
      ) : (
        <p className="mt-3 text-sm text-secondary">
          {t("DashboardCustody.policyAuditLegacyContextEmpty")}
        </p>
      )}
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
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 py-3 text-sm">
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
    <Button asChild variant="outline" size="sm" className="min-w-0 flex-1">
      <Link href={href}>
        {label}
        <ExternalLink className="size-4" />
      </Link>
    </Button>
  );
}

function MetadataLine({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <span className="shrink-0">{icon}</span>
      {label ? <span className="shrink-0 text-tertiary">{label}</span> : null}
      {children}
    </span>
  );
}

function NeighborButton({
  direction,
  href,
  label,
}: {
  direction: "previous" | "next";
  href: string | null;
  label: string;
}) {
  const icon =
    direction === "previous" ? (
      <ChevronLeft className="size-4" />
    ) : (
      <ChevronRight className="size-4" />
    );
  if (!href) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        iconLeft={direction === "previous" ? icon : undefined}
        iconRight={direction === "next" ? icon : undefined}
      >
        <span className="max-sm:sr-only">{label}</span>
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href} prefetch>
        {direction === "previous" ? icon : null}
        <span className="max-sm:sr-only">{label}</span>
        {direction === "next" ? icon : null}
      </Link>
    </Button>
  );
}

function walletLabel(wallet: CustodyWalletMetadataResponse["wallet"]): string {
  return wallet.label?.trim() || wallet.walletId;
}

/**
 * A neighboring evaluation's detail href, carrying the audit-list filters and
 * the neighbor's page so the list state survives stepping between evaluations.
 *
 * @param currentDetailBaseHref - The current evaluation's detail href without a query.
 * @param neighbor - The neighboring evaluation.
 * @param filters - Active audit-list filters to preserve.
 * @returns The neighbor's href.
 */
function neighborHref(
  currentDetailBaseHref: string,
  neighbor: PolicyAuditNeighbor,
  filters: PolicyAuditFilters
): string {
  const auditBase = currentDetailBaseHref.slice(0, currentDetailBaseHref.lastIndexOf("/"));
  const query = buildPolicyAuditSearchParams({ ...filters, page: neighbor.page }).toString();
  return `${auditBase}/${encodeURIComponent(neighbor.id)}${query ? `?${query}` : ""}`;
}
