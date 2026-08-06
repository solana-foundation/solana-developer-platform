import {
  type PolicyDecision,
  type WalletControlProfileRevisionHistory,
  type WalletOperationStatus,
  type WalletPolicyEvaluationDetail,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { formatDisplayLabel } from "@/lib/utils";

export type PolicyTranslate = (key: MessageKey, values?: TranslationValues) => string;

const DECISION_VARIANTS: Record<PolicyDecision, BadgeVariant> = {
  allow: "success",
  deny: "danger",
  approval_required: "warning",
  provider_approval_required: "warning",
  review: "warning",
  not_evaluated: "default",
};

const STATUS_VARIANTS: Record<WalletOperationStatus, BadgeVariant> = {
  created: "default",
  evaluated: "info",
  pending_approval: "warning",
  executing: "info",
  completed: "success",
  failed: "danger",
  canceled: "danger",
};

export function decisionLabel(decision: PolicyDecision, t: PolicyTranslate): string {
  const keys = {
    allow: "DashboardCustody.policyAuditAllowed",
    deny: "DashboardCustody.policyAuditBlocked",
    approval_required: "DashboardCustody.policyAuditApprovalRequired",
    provider_approval_required: "DashboardCustody.policyAuditApprovalRequired",
    review: "DashboardCustody.policyAuditReview",
    not_evaluated: "DashboardCustody.policyAuditNotEvaluated",
  } as const satisfies Record<PolicyDecision, MessageKey>;
  return t(keys[decision]);
}

export function DecisionBadge({ decision, t }: { decision: PolicyDecision; t: PolicyTranslate }) {
  return <Badge variant={DECISION_VARIANTS[decision]}>{decisionLabel(decision, t)}</Badge>;
}

export function OperationStatusBadge({ status }: { status: WalletOperationStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{formatDisplayLabel(status)}</Badge>;
}

export function PolicyAuditLoadError({
  backHref,
  backLabel,
  t,
}: {
  backHref: string;
  backLabel: string;
  t: PolicyTranslate;
}) {
  return (
    <div className="mx-auto max-w-xl border-y border-border-default py-16 text-center">
      <h1 className="text-xl font-medium text-primary">
        {t("DashboardCustody.policyAuditUnavailableTitle")}
      </h1>
      <p className="mt-2 text-sm text-secondary">
        {t("DashboardCustody.policyAuditUnavailableDescription")}
      </p>
      <Button asChild variant="outline" className="mt-5">
        <Link href={backHref}>{backLabel}</Link>
      </Button>
    </div>
  );
}

export function shortIdentifier(value: string, edge = 6): string {
  return value.length <= edge * 2 + 3 ? value : `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

const policyDateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Returns a cached formatter — these run once per audit/revision row per
 * render, and `Intl.DateTimeFormat` construction is expensive to repeat.
 *
 * @param locale - BCP 47 locale the formatter renders in.
 * @param timeStyle - Time component to append, if any.
 * @returns The shared formatter for that locale and style.
 */
function policyDateFormat(locale: string, timeStyle?: "short"): Intl.DateTimeFormat {
  const key = timeStyle ? `${locale}+${timeStyle}` : locale;
  let format = policyDateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle });
    policyDateFormats.set(key, format);
  }
  return format;
}

export function formatPolicyDateTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return policyDateFormat(locale, "short").format(date);
}

export function formatPolicyDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return policyDateFormat(locale).format(date);
}

export function formatOperation(evaluation: WalletPolicyEvaluationDetail): string {
  return `${formatDisplayLabel(evaluation.walletOperation.operationFamily)} · ${formatDisplayLabel(evaluation.walletOperation.operationType)}`;
}

export function formatAssetAmount(evaluation: WalletPolicyEvaluationDetail, empty: string): string {
  const { amount, asset } = evaluation.walletOperation;
  const displayAsset = asset
    ? (WELL_KNOWN_TOKEN_BY_MINT.get(asset)?.symbol ?? shortIdentifier(asset, 5))
    : null;
  if (amount && displayAsset) return `${amount} ${displayAsset}`;
  return amount ?? displayAsset ?? empty;
}

export function revisionNumber(
  history: WalletControlProfileRevisionHistory,
  revisionId: string | null
): number | null {
  if (!revisionId) return null;
  return history.revisions.find((revision) => revision.id === revisionId)?.revisionNumber ?? null;
}

export function formatRevisionReference(
  history: WalletControlProfileRevisionHistory,
  revisionId: string | null,
  empty: string
): string {
  if (!revisionId) return empty;
  const number = revisionNumber(history, revisionId);
  return number ? `#${number}` : shortIdentifier(revisionId);
}

export function requestIdFromEvaluation(evaluation: WalletPolicyEvaluationDetail): string | null {
  const requestId = evaluation.evaluationContext?.operation.context.requestId;
  return typeof requestId === "string" && requestId.trim() ? requestId : null;
}

export interface PolicyActor {
  type: "api_key" | "actor" | "source";
  id: string | null;
  name: string | null;
  value: string;
}

export function policyActor(
  evaluation: WalletPolicyEvaluationDetail,
  apiKeyNames: Record<string, string>,
  userNames: Record<string, string>
): PolicyActor {
  const operation = evaluation.evaluationContext?.operation;
  if (operation?.apiKeyId) {
    return {
      type: "api_key",
      id: operation.apiKeyId,
      name: apiKeyNames[operation.apiKeyId] ?? null,
      value: apiKeyNames[operation.apiKeyId] ?? operation.apiKeyId,
    };
  }
  if (operation?.actor) {
    const name = operation.actor.id ? (userNames[operation.actor.id] ?? null) : null;
    return {
      type: "actor",
      id: operation.actor.id,
      name,
      value:
        name ??
        (operation.actor.id
          ? `${formatDisplayLabel(operation.actor.type)} · ${operation.actor.id}`
          : formatDisplayLabel(operation.actor.type)),
    };
  }
  return {
    type: "source",
    id: null,
    name: null,
    value: operation?.source ? formatDisplayLabel(operation.source) : "",
  };
}

export type ProviderMappingState =
  | "pending"
  | "partial"
  | "failed"
  | "provider_approval"
  | "sdp_enforced";

export function providerMappingState(
  evaluation: WalletPolicyEvaluationDetail
): ProviderMappingState {
  if (evaluation.reasonCode === "provider_mapping_pending") return "pending";
  if (evaluation.reasonCode === "provider_mapping_partial") return "partial";
  if (evaluation.reasonCode === "provider_mapping_failed") return "failed";
  if (evaluation.decision === "provider_approval_required") return "provider_approval";
  return "sdp_enforced";
}

export function decisionHeading(evaluation: WalletPolicyEvaluationDetail): string {
  return formatOperation(evaluation);
}
