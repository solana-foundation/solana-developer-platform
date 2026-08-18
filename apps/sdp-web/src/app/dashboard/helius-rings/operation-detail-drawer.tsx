"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useTranslations } from "@/i18n/provider";
import { fetchRingsOperationDetail, type RingsOperationDetail } from "./helius-rings.data";

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

  return (
    <Drawer open={operationId !== null} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent className="flex w-full max-w-md flex-col gap-4 p-6">
        <DrawerTitle>{t("DashboardHeliusRings.detail.title")}</DrawerTitle>

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
                value={new Date(detail.createdAt).toLocaleString()}
              />
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
                  {detail.events.map((event, index) => (
                    <li
                      key={`${event.kind}-${index}`}
                      className="flex items-baseline justify-between gap-4"
                    >
                      <span className="text-sm text-primary">{event.kind}</span>
                      <span className="text-sm text-secondary">
                        {new Date(event.createdAt).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-secondary">{label}</dt>
      <dd className="break-all text-right text-sm text-primary">{value}</dd>
    </div>
  );
}
