"use client";

import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { useCopy } from "@/lib/use-copy";
import { fetchWebhookDeliveries, redeliverWebhookDelivery } from "../webhook-endpoints.client";
import type { WebhookDeliveriesPage, WebhookDeliveryView } from "../webhook-endpoints.data";
import {
  deliveriesPageCount,
  deliveryResultLabel,
  deliveryTone,
  formatDeliveryDuration,
} from "../webhook-endpoints.data";

const PAGE_SIZE = 25;

function formatWhen(value: string, locale: string): { text: string; tooltip: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { text: value, tooltip: value };
  }
  return {
    text: date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
    tooltip: date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" }),
  };
}

function CopyableBody({ label, body }: { label: string; body: string }) {
  const t = useTranslations();
  const { copied, copy } = useCopy();
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-tertiary">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? t("DashboardWebhooks.copied") : t("DashboardWebhooks.copy")}
          onClick={() => void copy(body)}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </div>
      {/* A code surface: mono is intentional here. */}
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border-default bg-fill p-3 font-mono text-xs whitespace-pre-wrap break-all text-primary">
        {body}
      </pre>
    </div>
  );
}

export function WebhookDeliveryLog({
  endpointId,
  endpointEnabled,
  canManage,
}: {
  endpointId: string;
  endpointEnabled: boolean;
  canManage: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [redeliveringId, setRedeliveringId] = useState<string | null>(null);

  // No persistedConfig on purpose: delivery bodies can carry sensitive payloads and
  // must not be snapshotted into localStorage.
  const swr = usePersistedDashboardSWR<WebhookDeliveriesPage>(
    ["webhook-deliveries", endpointId, page],
    () => fetchWebhookDeliveries(endpointId, page, PAGE_SIZE),
    { keepPreviousData: true, revalidateOnFocus: true }
  );

  const deliveries = swr.data?.deliveries ?? [];
  const total = swr.data?.total ?? 0;
  const pageCount = deliveriesPageCount(total, PAGE_SIZE);

  const handleRedeliver = async (delivery: WebhookDeliveryView) => {
    setRedeliveringId(delivery.id);
    try {
      await redeliverWebhookDelivery(endpointId, delivery.id);
      toast.success(t("DashboardWebhooks.toastRedelivered"));
      // The new manual row lands at the top of page 1.
      setPage(1);
      setExpandedId(null);
      void swr.mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("DashboardWebhooks.errorRedeliver"));
    } finally {
      setRedeliveringId(null);
    }
  };

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-primary">
            {t("DashboardWebhooks.deliveriesTitle")}
          </h2>
          <p className="mt-0.5 text-sm text-secondary">
            {t("DashboardWebhooks.deliveriesDescription")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t("DashboardWebhooks.refresh")}
          onClick={() => void swr.mutate()}
        >
          <RefreshCwIcon />
        </Button>
      </div>

      {swr.error && !swr.data ? (
        <div className="mt-4 rounded-xl border border-border-default p-8 text-center">
          <p className="text-sm text-secondary">{t("DashboardWebhooks.deliveriesLoadError")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => void swr.mutate()}
          >
            {t("DashboardWebhooks.retry")}
          </Button>
        </div>
      ) : deliveries.length === 0 ? (
        <div className="mt-4 rounded-xl border border-border-default p-8 text-center">
          <p className="text-sm text-secondary">{t("DashboardWebhooks.deliveriesEmpty")}</p>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-border-default">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t("DashboardWebhooks.columnResult")}</TableHead>
                <TableHead>{t("DashboardWebhooks.columnEvent")}</TableHead>
                <TableHead>{t("DashboardWebhooks.columnAttempt")}</TableHead>
                <TableHead>{t("DashboardWebhooks.columnDuration")}</TableHead>
                <TableHead>{t("DashboardWebhooks.columnWhen")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => {
                const expanded = expandedId === delivery.id;
                const when = formatWhen(delivery.createdAt, locale);
                return (
                  <Fragment key={delivery.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpandedId(expanded ? null : delivery.id)}
                    >
                      <TableCell className="w-8">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-expanded={expanded}
                          aria-label={
                            expanded
                              ? t("DashboardWebhooks.collapseRow")
                              : t("DashboardWebhooks.expandRow")
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedId(expanded ? null : delivery.id);
                          }}
                        >
                          {expanded ? (
                            <ChevronDownIcon className="size-4" />
                          ) : (
                            <ChevronRightIcon className="size-4" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <Badge
                            variant={deliveryTone(delivery) === "success" ? "success" : "danger"}
                          >
                            {deliveryResultLabel(delivery)}
                          </Badge>
                          {delivery.manual && (
                            <Badge variant="info">{t("DashboardWebhooks.deliveryManualTag")}</Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-secondary">{delivery.triggerType}</TableCell>
                      <TableCell className="text-secondary">{delivery.attempt}</TableCell>
                      <TableCell className="text-secondary">
                        {formatDeliveryDuration(delivery.durationMs) ?? "—"}
                      </TableCell>
                      <TableCell className="text-secondary" title={when.tooltip}>
                        {when.text}
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-fill/40">
                          <div className="space-y-4 px-2 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="space-y-1 text-xs text-secondary">
                                <div>
                                  <span className="font-medium text-tertiary">
                                    {t("DashboardWebhooks.deliveryId")}
                                  </span>{" "}
                                  {delivery.id}
                                </div>
                                {delivery.redeliveryOf && (
                                  <div>
                                    {t("DashboardWebhooks.deliveryRedeliveryOf", {
                                      id: delivery.redeliveryOf,
                                    })}
                                  </div>
                                )}
                                {delivery.error && (
                                  <div>
                                    <span className="font-medium text-tertiary">
                                      {t("DashboardWebhooks.deliveryError")}
                                    </span>{" "}
                                    {delivery.error}
                                  </div>
                                )}
                              </div>
                              {canManage && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    !endpointEnabled ||
                                    delivery.requestBodyTruncated ||
                                    redeliveringId !== null
                                  }
                                  onClick={() => void handleRedeliver(delivery)}
                                >
                                  {redeliveringId === delivery.id
                                    ? t("DashboardWebhooks.redelivering")
                                    : t("DashboardWebhooks.redeliver")}
                                </Button>
                              )}
                            </div>
                            {delivery.requestBodyTruncated && (
                              <p className="text-xs text-warning">
                                {t("DashboardWebhooks.deliveryRequestTruncated")}
                              </p>
                            )}
                            <CopyableBody
                              label={t("DashboardWebhooks.deliveryRequestBody")}
                              body={delivery.requestBody}
                            />
                            {delivery.responseBody ? (
                              <div>
                                <CopyableBody
                                  label={t("DashboardWebhooks.deliveryResponseBody")}
                                  body={delivery.responseBody}
                                />
                                {delivery.responseBody.length >= 4_096 && (
                                  <p className="mt-1 text-xs text-tertiary">
                                    {t("DashboardWebhooks.deliveryResponseTruncated")}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-tertiary">
                                {t("DashboardWebhooks.deliveryResponseEmpty")}
                              </p>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          <div className="border-t border-border-default px-4 py-3">
            <ArrowPagination
              page={page}
              pageCount={pageCount}
              onPageChange={(next) => {
                setExpandedId(null);
                setPage(next);
              }}
              disabled={swr.isValidating}
              summary={t("DashboardWebhooks.deliveriesSummary", {
                count: deliveries.length,
                total,
              })}
            />
          </div>
        </div>
      )}
    </section>
  );
}
