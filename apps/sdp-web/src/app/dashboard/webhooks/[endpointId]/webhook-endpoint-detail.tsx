"use client";

import { CheckIcon, CopyIcon, LockIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { useCopy } from "@/lib/use-copy";
import { ConfirmWebhookActionModal } from "../confirm-webhook-action-modal";
import { EditWebhookEndpointModal } from "../edit-webhook-endpoint-modal";
import { useWebhookEndpointActions } from "../use-webhook-endpoint-actions";
import { fetchWebhookEndpoint } from "../webhook-endpoints.client";
import type { WebhookEndpointView } from "../webhook-endpoints.data";
import { WebhookSecretModal } from "../webhook-secret-modal";
import { WebhookDeliveryLog } from "./webhook-delivery-log";

// A labeled caption row: the anchored home for the endpoint's URL / ID / metadata.
function DetailField({
  label,
  value,
  copyValue,
}: {
  label: string;
  value: string;
  copyValue?: string;
}) {
  const t = useTranslations();
  const { copied, copy } = useCopy();
  return (
    <div className="min-w-0">
      <span className="text-xs font-medium text-tertiary">{label}</span>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="truncate text-sm text-primary" title={value}>
          {value}
        </span>
        {copyValue && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? t("DashboardWebhooks.copied") : t("DashboardWebhooks.copy")}
            onClick={() => void copy(copyValue)}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
        )}
      </div>
    </div>
  );
}

export function WebhookEndpointDetail({
  initialEndpoint,
  canManage,
}: {
  initialEndpoint: WebhookEndpointView;
  canManage: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const swr = usePersistedDashboardSWR<WebhookEndpointView>(
    ["webhook-endpoint", initialEndpoint.id],
    () => fetchWebhookEndpoint(initialEndpoint.id),
    { fallbackData: initialEndpoint, revalidateOnFocus: true }
  );
  const endpoint = swr.data ?? initialEndpoint;
  const [editOpen, setEditOpen] = useState(false);
  const actions = useWebhookEndpointActions({
    onChanged: () => void swr.mutate(),
    onDeleted: () => router.push("/dashboard/webhooks"),
  });

  const createdAt = new Date(endpoint.createdAt);
  const graceExpiresAt =
    endpoint.previousSecretExpiresAt && Date.parse(endpoint.previousSecretExpiresAt) > Date.now()
      ? new Date(endpoint.previousSecretExpiresAt)
      : null;

  return (
    <div className="h-full overflow-y-auto px-3 pb-8 md:px-6">
      <div className="mx-auto w-full max-w-[1200px] py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-medium text-primary">{endpoint.label}</h1>
            <Badge variant={endpoint.status === "active" ? "success" : "default"}>
              {endpoint.status === "active"
                ? t("DashboardWebhooks.statusActive")
                : t("DashboardWebhooks.statusDisabled")}
            </Badge>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                {t("DashboardWebhooks.editEndpoint")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => actions.requestRotate(endpoint)}
              >
                {t("DashboardWebhooks.rotateSecret")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => actions.requestToggle(endpoint)}
              >
                {endpoint.status === "active"
                  ? t("DashboardWebhooks.disable")
                  : t("DashboardWebhooks.enable")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => actions.requestDelete(endpoint)}
              >
                {t("DashboardWebhooks.delete")}
              </Button>
            </div>
          )}
        </header>
        {endpoint.description && (
          <p className="mt-2 text-sm text-secondary">{endpoint.description}</p>
        )}

        <section className="mt-6 rounded-xl border border-border-default p-5">
          <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
            <DetailField
              label={t("DashboardWebhooks.detailUrl")}
              value={endpoint.url}
              copyValue={endpoint.url}
            />
            <DetailField
              label={t("DashboardWebhooks.detailEndpointId")}
              value={endpoint.id}
              copyValue={endpoint.id}
            />
            <DetailField
              label={t("DashboardWebhooks.detailCreated")}
              value={createdAt.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
            />
            <div className="min-w-0">
              <span className="text-xs font-medium text-tertiary">
                {t("DashboardWebhooks.detailSecret")}
              </span>
              <div className="mt-0.5 flex items-center gap-1.5 text-sm text-primary">
                <LockIcon aria-hidden className="size-3.5 text-secondary" />
                <span>
                  {t("DashboardWebhooks.secretConfigured")} ·{" "}
                  {t("DashboardWebhooks.detailSecretVersion", { version: endpoint.secretVersion })}
                </span>
              </div>
              {graceExpiresAt && (
                <p className="mt-1 text-xs text-secondary">
                  {t("DashboardWebhooks.detailGraceUntil", {
                    expiresAt: graceExpiresAt.toLocaleString(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </p>
              )}
            </div>
          </div>
        </section>

        <WebhookDeliveryLog
          endpointId={endpoint.id}
          endpointEnabled={endpoint.status === "active"}
          canManage={canManage}
        />
      </div>

      <EditWebhookEndpointModal
        endpoint={editOpen ? endpoint : null}
        onClose={() => setEditOpen(false)}
        onUpdated={() => {
          setEditOpen(false);
          void swr.mutate();
        }}
      />
      <ConfirmWebhookActionModal
        confirm={actions.confirm}
        pending={actions.pending}
        onCancel={actions.cancelConfirm}
      />
      <WebhookSecretModal revealed={actions.revealedSecret} onClose={actions.closeSecret} />
    </div>
  );
}
