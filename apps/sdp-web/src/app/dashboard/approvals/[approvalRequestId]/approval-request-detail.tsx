"use client";

import type { WalletApprovalRequestSummary, WalletPolicyEvaluationDetail } from "@sdp/types";
import { Check, Copy, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  type ApprovalAction,
  type ApprovalActionResponse,
  buildApprovalActionPath,
  classifyApprovalActionResponse,
  readApprovalActionResponse,
} from "../approval-actions";
import { ApprovalStatusBadge } from "../approval-request-shared";
import {
  type ApprovalExecutionState,
  approvalApiKeyLabel,
  approvalBadgeStatus,
  approvalExecutionState,
  approvalReason,
  approvalWalletLabel,
  formatApprovalDateTime,
  formatApprovalLabel,
  shortApprovalIdentifier,
} from "../approval-requests.data";

interface ApprovalRequestDetailProps {
  initialRequest: WalletApprovalRequestSummary;
  evaluation: WalletPolicyEvaluationDetail | null;
  apiKeyNames: Record<string, string>;
  canDecide: boolean;
}

const ACTION_COPY = {
  approve: {
    title: "DashboardApprovals.approveTitle",
    description: "DashboardApprovals.approveDescription",
    confirm: "DashboardApprovals.approveConfirm",
    success: "DashboardApprovals.approvedToast",
  },
  reject: {
    title: "DashboardApprovals.rejectTitle",
    description: "DashboardApprovals.rejectDescription",
    confirm: "DashboardApprovals.rejectConfirm",
    success: "DashboardApprovals.rejectedToast",
  },
  cancel: {
    title: "DashboardApprovals.cancelTitle",
    description: "DashboardApprovals.cancelDescription",
    confirm: "DashboardApprovals.cancelConfirm",
    success: "DashboardApprovals.canceledToast",
  },
} as const;

const RULE_TYPE_KEYS = ["type", "kind", "ruleType", "rule_type"];

const ADMISSION_ERROR_COPY = {
  runtime_paused: "DashboardApprovals.runtimePaused",
  runtime_unavailable: "DashboardApprovals.runtimeUnavailable",
  provider_not_entitled: "DashboardApprovals.providerAccessDenied",
} as const;

const EXECUTION_COPY = {
  succeeded: "DashboardApprovals.executionSucceeded",
  running: "DashboardApprovals.executionRunning",
  not_run: "DashboardApprovals.executionNotRun",
} as const satisfies Record<Exclude<ApprovalExecutionState, "failed">, MessageKey>;

/** Either a catalog key or the API's own words, which are already user-facing. */
type FeedbackMessage = { key: MessageKey } | { text: string };

type DecisionFeedback =
  | {
      settled: true;
      /** The decided request, or null when it has to be fetched again. */
      request: WalletApprovalRequestSummary | null;
      message: MessageKey;
      tone: "success" | "error";
    }
  | { settled: false; message: FeedbackMessage; closeConfirmation: boolean };

/**
 * Maps a decision response to what the page does next. Settled outcomes show
 * the latest request; refusals leave the request as it was. A refusal's own
 * message names the rule the caller did not meet, so it wins over the generic
 * role line.
 */
function decisionFeedback(
  action: ApprovalAction,
  result: ApprovalActionResponse
): DecisionFeedback {
  if (result.ok) {
    return {
      settled: true,
      request: result.approvalRequest,
      message: ACTION_COPY[action].success,
      tone: "success",
    };
  }
  const outcome = classifyApprovalActionResponse(result.status, result.reason);
  switch (outcome) {
    case "stale":
      return {
        settled: true,
        request: null,
        message: "DashboardApprovals.alreadyDecided",
        tone: "error",
      };
    case "runtime_paused":
    case "runtime_unavailable":
    case "provider_not_entitled":
      return {
        settled: false,
        message: { key: ADMISSION_ERROR_COPY[outcome] },
        closeConfirmation: true,
      };
    case "forbidden":
      return {
        settled: false,
        message: result.message
          ? { text: result.message }
          : { key: "DashboardApprovals.forbiddenDecision" },
        closeConfirmation: true,
      };
    default:
      return {
        settled: false,
        message: result.message
          ? { text: result.message }
          : { key: "DashboardApprovals.decisionFailed" },
        closeConfirmation: false,
      };
  }
}

/** Holds the request on screen and runs approve, reject and cancel against it. */
function useApprovalDecision(initialRequest: WalletApprovalRequestSummary) {
  const t = useTranslations();
  const [request, setRequest] = useState(initialRequest);
  const [confirmation, setConfirmation] = useState<ApprovalAction | null>(null);
  const [activeAction, setActiveAction] = useState<ApprovalAction | null>(null);

  function showLatest(latest: WalletApprovalRequestSummary) {
    setRequest(latest);
    window.dispatchEvent(new Event("sdp:approval-requests-updated"));
  }

  async function refreshRequest(): Promise<WalletApprovalRequestSummary | null> {
    try {
      const response = await fetch(
        `/api/dashboard/approval-requests/${encodeURIComponent(request.id)}`,
        { cache: "no-store" }
      );
      const result = await readApprovalActionResponse(response);
      if (result.ok && result.approvalRequest) {
        showLatest(result.approvalRequest);
        return result.approvalRequest;
      }
    } catch {
      // The action feedback below remains the useful message when refresh also fails.
    }
    return null;
  }

  async function decide(action: ApprovalAction) {
    setActiveAction(action);
    try {
      const response = await fetch(buildApprovalActionPath(request.id, action), { method: "POST" });
      const feedback = decisionFeedback(action, await readApprovalActionResponse(response));
      if (!feedback.settled) {
        if (feedback.closeConfirmation) setConfirmation(null);
        toast.error("key" in feedback.message ? t(feedback.message.key) : feedback.message.text);
        return;
      }
      if (feedback.request) showLatest(feedback.request);
      const latest = feedback.request ?? (await refreshRequest());
      setConfirmation(null);
      if (feedback.tone === "error") {
        toast.error(t(feedback.message));
      } else if (latest && approvalExecutionState(latest) === "failed") {
        // Approving runs the operation in the same call. A run that failed must
        // not be announced as a plain success.
        toast.error(t("DashboardApprovals.approvedExecutionFailedToast"));
      } else {
        toast.success(t(feedback.message));
      }
    } catch {
      toast.error(t("DashboardApprovals.decisionFailed"));
    } finally {
      setActiveAction(null);
    }
  }

  return { request, confirmation, setConfirmation, activeAction, decide };
}

export function ApprovalRequestDetail({
  initialRequest,
  evaluation,
  apiKeyNames,
  canDecide,
}: ApprovalRequestDetailProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { request, confirmation, setConfirmation, activeAction, decide } =
    useApprovalDecision(initialRequest);
  const apiKeyLabel = approvalApiKeyLabel(
    request,
    apiKeyNames,
    t("DashboardApprovals.directRequest")
  );

  return (
    <div className="h-full overflow-y-auto px-3 pb-10 outline-none md:px-6">
      <div className="mx-auto w-full max-w-[1500px] py-6">
        <ApprovalRequestHeader
          request={request}
          canDecide={canDecide}
          busy={Boolean(activeAction)}
          onAction={setConfirmation}
        />
        <ApprovalRequestNotice request={request} canDecide={canDecide} locale={locale} />

        <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_360px]">
          <ApprovalRequestSections
            request={request}
            evaluation={evaluation}
            apiKeyLabel={apiKeyLabel}
            locale={locale}
          />
          <ApprovalRequestMetadata
            request={request}
            evaluation={evaluation}
            apiKeyLabel={apiKeyLabel}
            locale={locale}
          />
        </div>
      </div>

      <ApprovalDecisionModal
        action={confirmation}
        isPending={Boolean(activeAction)}
        onClose={() => setConfirmation(null)}
        onConfirm={() => confirmation && decide(confirmation)}
      />
    </div>
  );
}

function ApprovalRequestHeader({
  request,
  canDecide,
  busy,
  onAction,
}: {
  request: WalletApprovalRequestSummary;
  canDecide: boolean;
  busy: boolean;
  onAction: (action: ApprovalAction) => void;
}) {
  const t = useTranslations();
  const isPending = request.status === "pending";
  // The API refuses a decision from whoever raised the request, so neither
  // decision is offered to them. Withdrawing it stays theirs.
  const canApproveOrReject = isPending && canDecide && !request.viewerIsRequester;

  return (
    <header className="flex flex-wrap items-start justify-between gap-5 border-b border-border-default pb-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <ApprovalStatusBadge status={approvalBadgeStatus(request)} />
          <span className="text-xs text-secondary">{shortApprovalIdentifier(request.id, 8)}</span>
        </div>
        <h1 className="mt-4 text-2xl font-medium text-primary sm:text-3xl">
          {t("DashboardApprovals.reviewTitle", {
            operation: formatApprovalLabel(request.operation.operationFamily),
          })}
        </h1>
        {canApproveOrReject ? (
          <p className="mt-2 max-w-2xl text-sm text-secondary">
            {t("DashboardApprovals.reviewDescription")}
          </p>
        ) : null}
      </div>

      {isPending && canDecide ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onAction("cancel")}
            disabled={busy}
          >
            {t("DashboardApprovals.cancel")}
          </Button>
          {canApproveOrReject ? (
            <>
              <Button
                type="button"
                variant="destructive"
                onClick={() => onAction("reject")}
                disabled={busy}
                iconLeft={<X className="size-4" />}
              >
                {t("DashboardApprovals.reject")}
              </Button>
              <Button
                type="button"
                onClick={() => onAction("approve")}
                disabled={busy}
                iconLeft={<Check className="size-4" />}
              >
                {t("DashboardApprovals.approve")}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

/**
 * The one line under the header: who can decide a pending request, or what
 * running an approved one did. Other statuses need nothing beyond the badge.
 */
function ApprovalRequestNotice({
  request,
  canDecide,
  locale,
}: {
  request: WalletApprovalRequestSummary;
  canDecide: boolean;
  locale: string;
}) {
  const t = useTranslations();
  if (request.status === "pending") {
    if (canDecide && !request.viewerIsRequester) return null;
    return (
      <p className="border-b border-border-default bg-fill-subtle px-3 py-2 text-sm text-secondary">
        {t(canDecide ? "DashboardApprovals.requesterCannotDecide" : "DashboardApprovals.viewOnly")}
      </p>
    );
  }

  const execution = approvalExecutionState(request);
  if (!execution) return null;
  const failed = execution === "failed";
  const completedAt = request.operation.executionCompletedAt;
  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-3 py-2 text-sm",
        failed
          ? "border-error-border bg-error-bg text-error"
          : "border-border-default bg-fill-subtle text-secondary"
      )}
    >
      <p className="min-w-0 break-words">
        {failed
          ? (request.operation.executionError ?? t("DashboardApprovals.executionErrorMissing"))
          : t(EXECUTION_COPY[execution])}
      </p>
      {completedAt ? (
        <time className="text-xs" dateTime={completedAt}>
          {formatApprovalDateTime(completedAt, locale)}
        </time>
      ) : null}
    </div>
  );
}

function ApprovalRequestSections({
  request,
  evaluation,
  apiKeyLabel,
  locale,
}: {
  request: WalletApprovalRequestSummary;
  evaluation: WalletPolicyEvaluationDetail | null;
  apiKeyLabel: string;
  locale: string;
}) {
  const t = useTranslations();
  const { operation } = request;
  return (
    <main className="min-w-0 lg:pr-8">
      <DetailSection title={t("DashboardApprovals.requestSection")}>
        <DetailGrid>
          <DetailValue label={t("DashboardApprovals.submittedBy")} value={apiKeyLabel} />
          <DetailValue
            label={t("DashboardApprovals.submittedAt")}
            value={formatApprovalDateTime(request.createdAt, locale)}
          />
          <DetailValue
            label={t("DashboardApprovals.expiresAt")}
            value={formatApprovalDateTime(request.expiresAt, locale)}
          />
        </DetailGrid>
      </DetailSection>

      <DetailSection title={t("DashboardApprovals.policyDecisionSection")}>
        <DetailGrid>
          <DetailValue
            label={t("DashboardApprovals.policyDecision")}
            value={formatApprovalLabel(
              request.policyEvaluation?.decision ?? evaluation?.decision ?? "not_reported"
            )}
          />
          <DetailValue
            label={t("DashboardApprovals.reasonCode")}
            value={formatApprovalLabel(
              request.policyEvaluation?.reasonCode ?? evaluation?.reasonCode ?? "not_reported"
            )}
          />
          <DetailValue
            className="sm:col-span-2"
            label={t("DashboardApprovals.policyReason")}
            value={approvalReason(request, t("DashboardApprovals.approvalRequiredByPolicy"))}
          />
        </DetailGrid>
      </DetailSection>

      <DetailSection title={t("DashboardApprovals.operationDetailsSection")}>
        <DetailGrid>
          <DetailValue
            label={t("DashboardApprovals.operationFamily")}
            value={formatApprovalLabel(operation.operationFamily)}
          />
          <DetailValue
            label={t("DashboardApprovals.operationType")}
            value={operation.operationType}
          />
          <DetailValue label={t("DashboardApprovals.amount")} value={operation.amount ?? "-"} />
          <DetailValue label={t("DashboardApprovals.asset")} value={operation.asset ?? "-"} />
          <DetailValue
            className="sm:col-span-2"
            label={t("DashboardApprovals.destination")}
            value={operation.destination ?? "-"}
            mono={Boolean(operation.destination)}
          />
          <DetailValue label={t("DashboardApprovals.source")} value={operation.source ?? "-"} />
        </DetailGrid>
      </DetailSection>

      <DetailSection title={t("DashboardApprovals.matchedControlsSection")}>
        <MatchedControls
          rules={evaluation?.matchedRules ?? request.policyEvaluation?.matchedRules ?? []}
        />
      </DetailSection>

      <DetailSection title={t("DashboardApprovals.timelineSection")} last>
        <Timeline request={request} locale={locale} />
      </DetailSection>
    </main>
  );
}

function ApprovalRequestMetadata({
  request,
  evaluation,
  apiKeyLabel,
  locale,
}: {
  request: WalletApprovalRequestSummary;
  evaluation: WalletPolicyEvaluationDetail | null;
  apiKeyLabel: string;
  locale: string;
}) {
  const t = useTranslations();
  const walletAddress = request.wallet?.publicKey ?? request.operation.walletId;
  const walletRevisionId = evaluation?.policyRevisions.wallet.evaluatedRevisionId;
  const apiKeyRevisionId = evaluation?.policyRevisions.apiKey.evaluatedRevisionId;

  async function copyRequestId() {
    try {
      await navigator.clipboard.writeText(request.id);
      toast.success(t("DashboardApprovals.requestIdCopied"));
    } catch {
      // Browsers without clipboard access still show the full ID in the title attribute.
    }
  }

  return (
    <aside className="border-t border-border-default py-7 lg:border-t-0 lg:border-l lg:py-8 lg:pl-8">
      <div className="lg:sticky lg:top-6">
        <h2 className="text-base font-medium text-primary">{t("DashboardApprovals.metadata")}</h2>
        <dl className="mt-4 divide-y divide-border-default border-y border-border-default">
          <MetadataRow
            label={t("DashboardApprovals.wallet")}
            value={approvalWalletLabel(request)}
          />
          <MetadataRow
            label={t("DashboardApprovals.walletAddress")}
            value={shortApprovalIdentifier(walletAddress)}
            title={walletAddress}
          />
          <MetadataRow
            label={t("DashboardApprovals.requester")}
            value={shortApprovalIdentifier(request.requestedBy)}
            title={request.requestedBy ?? undefined}
          />
          <MetadataRow
            label={t("DashboardApprovals.apiKey")}
            value={apiKeyLabel}
            title={request.operation.apiKeyId ?? undefined}
          />
          <MetadataRow
            label={t("DashboardApprovals.walletRevision")}
            value={shortApprovalIdentifier(walletRevisionId)}
            title={walletRevisionId ?? undefined}
          />
          <MetadataRow
            label={t("DashboardApprovals.apiKeyRevision")}
            value={shortApprovalIdentifier(apiKeyRevisionId)}
            title={apiKeyRevisionId ?? undefined}
          />
          <MetadataRow
            label={t("DashboardApprovals.provider")}
            value={request.provider || t("DashboardApprovals.notReported")}
          />
          <MetadataRow
            label={t("DashboardApprovals.providerStatus")}
            value={formatApprovalLabel(request.operation.status)}
          />
          <MetadataRow
            label={t("DashboardApprovals.requestId")}
            value={shortApprovalIdentifier(request.id, 8)}
            title={request.id}
            action={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={copyRequestId}
                aria-label={t("DashboardApprovals.copyRequestId")}
                title={t("DashboardApprovals.copyRequestId")}
              >
                <Copy className="size-3" />
              </Button>
            }
          />
          <MetadataRow
            label={t("DashboardApprovals.submitted")}
            value={formatApprovalDateTime(request.createdAt, locale)}
          />
          <MetadataRow
            label={t("DashboardApprovals.currentStatus")}
            value={formatApprovalLabel(request.status)}
          />
          {request.resolvedBy ? (
            <MetadataRow
              label={t("DashboardApprovals.resolvedBy")}
              value={shortApprovalIdentifier(request.resolvedBy)}
              title={request.resolvedBy}
            />
          ) : null}
          {request.resolvedAt ? (
            <MetadataRow
              label={t("DashboardApprovals.resolvedAt")}
              value={formatApprovalDateTime(request.resolvedAt, locale)}
            />
          ) : null}
        </dl>
      </div>
    </aside>
  );
}

function DetailSection({
  title,
  children,
  last = false,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section className={last ? "py-8" : "border-b border-border-default py-8"}>
      <h2 className="text-lg font-medium text-primary">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function DetailGrid({ children }: { children: React.ReactNode }) {
  return <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">{children}</dl>;
}

function DetailValue({
  label,
  value,
  className,
  mono = false,
}: {
  label: string;
  value: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-secondary">{label}</dt>
      <dd
        className={
          mono ? "mt-1 break-all font-mono text-sm text-primary" : "mt-1 text-sm text-primary"
        }
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function MatchedControls({ rules }: { rules: Record<string, unknown>[] }) {
  const t = useTranslations();
  if (rules.length === 0) {
    return <p className="text-sm text-secondary">{t("DashboardApprovals.noMatchedControls")}</p>;
  }

  return (
    <div className="divide-y divide-border-default border-y border-border-default">
      {rules.map((rule, index) => {
        const type = firstRuleString(rule, RULE_TYPE_KEYS);
        const entries = Object.entries(rule).filter(([key]) => !RULE_TYPE_KEYS.includes(key));
        return (
          <div key={ruleKey(rule)} className="py-4">
            <p className="text-sm font-medium text-primary">
              {type
                ? formatApprovalLabel(type)
                : t("DashboardApprovals.matchedControl", { number: index + 1 })}
            </p>
            {entries.length > 0 ? (
              <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {entries.map(([key, value]) => (
                  <div
                    key={key}
                    className="grid grid-cols-[minmax(100px,0.7fr)_minmax(0,1fr)] gap-3 text-xs"
                  >
                    <dt className="text-secondary">{formatApprovalLabel(key)}</dt>
                    <dd className="break-words text-primary" title={formatRuleValue(value)}>
                      {formatRuleValue(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function firstRuleString(rule: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = rule[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function ruleKey(rule: Record<string, unknown>): string {
  const id = firstRuleString(rule, ["id", "ruleId", "rule_id"]);
  return id ?? JSON.stringify(rule);
}

function formatRuleValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function Timeline({ request, locale }: { request: WalletApprovalRequestSummary; locale: string }) {
  const t = useTranslations();
  const events = [
    {
      id: "submitted",
      title: t("DashboardApprovals.submittedEvent"),
      description: t("DashboardApprovals.submittedEventDescription"),
      time: request.createdAt,
    },
    ...(request.resolvedAt
      ? [
          {
            id: "resolved",
            title: t("DashboardApprovals.resolvedEvent", {
              status: formatApprovalLabel(request.status).toLowerCase(),
            }),
            description: t("DashboardApprovals.resolvedEventDescription", {
              actor: shortApprovalIdentifier(request.resolvedBy) || "-",
            }),
            time: request.resolvedAt,
          },
        ]
      : []),
  ];

  return (
    <ol className="space-y-0">
      {events.map((event, index) => (
        <li key={event.id} className="grid grid-cols-[16px_minmax(0,1fr)] gap-3">
          <div className="flex flex-col items-center">
            <span className="mt-1.5 size-2 rounded-full bg-primary" />
            {index < events.length - 1 ? (
              <span className="min-h-12 w-px flex-1 bg-border-default" />
            ) : null}
          </div>
          <div className={index < events.length - 1 ? "pb-6" : ""}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-primary">{event.title}</p>
              <time className="text-xs text-tertiary" dateTime={event.time}>
                {formatApprovalDateTime(event.time, locale)}
              </time>
            </div>
            <p className="mt-1 text-sm text-secondary">{event.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function MetadataRow({
  label,
  value,
  title,
  action,
}: {
  label: string;
  value: string;
  title?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(105px,0.75fr)_minmax(0,1fr)] items-center gap-4 py-3 text-sm">
      <dt className="text-secondary">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-1 text-right text-primary">
        <span className="truncate" title={title ?? value}>
          {value}
        </span>
        {action}
      </dd>
    </div>
  );
}

function ApprovalDecisionModal({
  action,
  isPending,
  onClose,
  onConfirm,
}: {
  action: ApprovalAction | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  if (!action) return null;
  const copy = ACTION_COPY[action];

  return (
    <Modal
      isOpen
      onClose={onClose}
      closeDisabled={isPending}
      ariaLabel={t(copy.title)}
      contentClassName="rounded-lg border-border-default p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]"
      size="sm"
    >
      <h2 className="pr-12 text-xl font-medium text-primary">{t(copy.title)}</h2>
      <p className="mt-2 text-sm leading-6 text-secondary">{t(copy.description)}</p>
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
          {t("DashboardApprovals.notNow")}
        </Button>
        <Button
          type="button"
          variant={action === "approve" ? "default" : "destructive"}
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? t("DashboardApprovals.decisionInProgress") : t(copy.confirm)}
        </Button>
      </div>
    </Modal>
  );
}
