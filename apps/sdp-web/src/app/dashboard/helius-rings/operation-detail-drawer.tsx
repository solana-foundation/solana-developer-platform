"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { fetchRingsOperationDetail, type RingsOperationDetail } from "./helius-rings.data";
import { formatTimeOfDay, formatWhen } from "./helius-rings.utils";

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
                  <Badge variant={detail.state === "failed" ? "danger" : "default"}>
                    {t(`DashboardHeliusRings.activity.state_${detail.state}`)}
                  </Badge>
                </dd>
              </div>
              {detail.amountRaw ? (
                <DetailRow
                  label={t("DashboardHeliusRings.activity.amount")}
                  value={detail.amountRaw}
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

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-primary">
                {t("DashboardHeliusRings.detail.timeline")}
              </span>
              {detail.events.length === 0 ? (
                <p className="text-sm text-secondary">
                  {t("DashboardHeliusRings.detail.timelineEmpty")}
                </p>
              ) : (
                <ol className="flex flex-col gap-1.5">
                  {keyedEvents.map((event) => (
                    <li key={event.key} className="flex items-baseline justify-between gap-4">
                      <span className="text-sm text-primary">{formatEventKind(event)}</span>
                      <span className="text-sm text-secondary">
                        {formatTimeOfDay(event.createdAt, locale)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

// `state.transitioned` alone hides the useful bit — surface the destination
// state from the event payload so the timeline reads as a state trace.
function formatEventKind(event: RingsOperationDetail["events"][number]): string {
  if (event.kind !== "state.transitioned") return event.kind;
  const to = event.payload && typeof event.payload === "object" ? event.payload.to : undefined;
  return typeof to === "string" ? `state.transitioned(${to})` : event.kind;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-secondary">{label}</dt>
      <dd className="break-all text-right text-sm text-primary">{value}</dd>
    </div>
  );
}
