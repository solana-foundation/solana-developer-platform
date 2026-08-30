"use client";

import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/modal";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  fetchRingsOperationDetail,
  type RingsOperationDetail,
  type RingsOperationState,
} from "./helius-rings.data";
import { formatAssetAmount, formatWhen } from "./helius-rings.utils";

type Translate = ReturnType<typeof useTranslations>;

// Mirrors activity-card.tsx so completed reads green here too, not default grey.
const STATE_BADGE: Record<RingsOperationState, "default" | "success" | "warning" | "danger"> = {
  draft: "default",
  preparing: "default",
  approval_required: "warning",
  proving: "default",
  ready_to_sign: "default",
  submitted: "default",
  indexing: "default",
  completed: "success",
  failed: "danger",
  voided: "default",
};

/**
 * Operation detail: identity, failure (code + message, verbatim), and the
 * event timeline oldest-first. Payloads shown here were redacted at write
 * time, so nothing sensitive can surface however the operation went.
 */
export function OperationDetailDrawer({
  operationId,
  onClose,
}: {
  operationId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [detail, setDetail] = useState<RingsOperationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFailedCopy = t("DashboardHeliusRings.errors.loadFailed");

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!operationId) return;
    fetchRingsOperationDetail(operationId, loadFailedCopy)
      .then((result) => setDetail(result.operation))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : loadFailedCopy));
  }, [operationId, loadFailedCopy]);

  // Content-derived keys: the timeline is append-only, so kind + timestamp
  // plus an occurrence counter is stable across re-renders without leaning on
  // the array index.
  const keyedEvents = useMemo(() => {
    const seen = new Map<string, number>();
    return (detail?.events ?? []).map((event) => {
      const base = `${event.kind}:${event.createdAt}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      return { ...event, key: `${base}:${occurrence}` };
    });
  }, [detail]);

  const title = t("DashboardHeliusRings.detail.title");

  return (
    <Modal isOpen={operationId !== null} ariaLabel={title} onClose={onClose} size="md">
      <div className="flex max-h-[calc(100vh-4rem)] flex-col gap-4 overflow-y-auto p-6 pr-14">
        <h2 className="text-base font-medium text-primary">{title}</h2>

        {error ? <Callout variant="danger">{error}</Callout> : null}

        {detail ? (
          <>
            <dl className="flex flex-col gap-2">
              <DetailRow label={t("DashboardHeliusRings.detail.operationId")} value={detail.id} />
              <DetailRow
                label={t("DashboardHeliusRings.activity.operation")}
                value={t(`DashboardHeliusRings.activity.opType_${detail.opType}`)}
              />
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-secondary">
                  {t("DashboardHeliusRings.activity.state")}
                </dt>
                <dd>
                  <Badge variant={STATE_BADGE[detail.state]}>
                    {t(`DashboardHeliusRings.activity.state_${detail.state}`)}
                  </Badge>
                </dd>
              </div>
              {detail.amountRaw ? (
                <DetailRow
                  label={t("DashboardHeliusRings.activity.amount")}
                  value={formatAssetAmount(detail.amountRaw, detail.assetMint)}
                />
              ) : null}
              <DetailRow
                label={t("DashboardHeliusRings.activity.created")}
                value={formatWhen(detail.createdAt, locale)}
              />
              {detail.retryOfOperationId ? (
                <DetailRow
                  label={t("DashboardHeliusRings.detail.retryOf")}
                  value={detail.retryOfOperationId}
                />
              ) : null}
            </dl>

            {detail.failure ? (
              <Callout variant="danger">
                <span className="font-medium">{detail.failure.code}</span> —{" "}
                {detail.failure.message}
                {detail.failure.retryable
                  ? ` ${t("DashboardHeliusRings.detail.retryable")}`
                  : ` ${t("DashboardHeliusRings.detail.notRetryable")}`}
              </Callout>
            ) : null}

            <div className="flex flex-col gap-3">
              <span className="text-sm font-medium text-primary">
                {t("DashboardHeliusRings.detail.timeline")}
              </span>
              {detail.events.length === 0 ? (
                <p className="text-sm text-secondary">
                  {t("DashboardHeliusRings.detail.timelineEmpty")}
                </p>
              ) : (
                <ol className="flex max-h-[45vh] flex-col overflow-y-auto pr-1">
                  {keyedEvents.map((event, index) => {
                    const last = index === keyedEvents.length - 1;
                    return (
                      <li key={event.key} className="flex gap-2">
                        {/* Icon column: circle + connector line to the next event. */}
                        <div className="flex flex-col items-center">
                          <span className="flex size-3.5 items-center justify-center rounded-full bg-success">
                            <Check aria-hidden="true" className="size-2 text-on-primary" />
                          </span>
                          {last ? null : (
                            <span
                              aria-hidden="true"
                              className="my-0.5 w-px flex-1 bg-border-default"
                            />
                          )}
                        </div>
                        <div className={last ? "flex flex-col" : "flex flex-col pb-2"}>
                          <span className="text-[11px] font-medium text-primary">
                            {formatEventKind(event, t)}
                          </span>
                          <span className="text-[10px] text-secondary">
                            {formatWhen(event.createdAt, locale)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

// Short human-facing label per event kind and per target state; falls back to
// the raw kind so a new upstream event is visible rather than silently missing.
const TIMELINE_STATES = new Set<RingsOperationState>([
  "draft",
  "preparing",
  "approval_required",
  "proving",
  "ready_to_sign",
  "submitted",
  "indexing",
  "completed",
  "failed",
  "voided",
]);

const EVENT_KEY: Record<string, MessageKey> = {
  "operation.created": "DashboardHeliusRings.detail.event_created",
  "operation.retried": "DashboardHeliusRings.detail.event_retried",
  "policy.evaluated": "DashboardHeliusRings.detail.event_policyEvaluated",
  "approval.requested": "DashboardHeliusRings.detail.event_approvalRequested",
  "approval.granted": "DashboardHeliusRings.detail.event_approvalGranted",
  "proof.received": "DashboardHeliusRings.detail.event_proofReceived",
  "transaction.submitted": "DashboardHeliusRings.detail.event_transactionSubmitted",
  "operation.completed": "DashboardHeliusRings.detail.event_completed",
  "operation.failed": "DashboardHeliusRings.detail.event_failed",
  "operation.voided": "DashboardHeliusRings.detail.event_voided",
  "operation.escalated": "DashboardHeliusRings.detail.event_escalated",
};

function formatEventKind(event: RingsOperationDetail["events"][number], t: Translate): string {
  if (event.kind === "state.transitioned") {
    const to = event.payload && typeof event.payload === "object" ? event.payload.to : undefined;
    if (typeof to === "string" && TIMELINE_STATES.has(to as RingsOperationState)) {
      return t(`DashboardHeliusRings.detail.timelineState_${to as RingsOperationState}`);
    }
    if (typeof to === "string") return to;
  }
  const key = EVENT_KEY[event.kind];
  return key ? t(key) : event.kind;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-secondary">{label}</dt>
      <dd className="break-all text-right text-sm text-primary">{value}</dd>
    </div>
  );
}
