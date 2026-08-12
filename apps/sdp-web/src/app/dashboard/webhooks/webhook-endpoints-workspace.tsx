"use client";

import { LockIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { ConfirmWebhookActionModal } from "./confirm-webhook-action-modal";
import { CreateWebhookEndpointModal } from "./create-webhook-endpoint-modal";
import { EditWebhookEndpointModal } from "./edit-webhook-endpoint-modal";
import { useWebhookEndpointActions } from "./use-webhook-endpoint-actions";
import { WebhookEndpointActionsMenu } from "./webhook-endpoint-actions-menu";
import { fetchWebhookEndpoints } from "./webhook-endpoints.client";
import type { WebhookEndpointView } from "./webhook-endpoints.data";
import { WebhookEndpointsListSkeleton } from "./webhook-page-skeletons";
import { WebhookSecretModal } from "./webhook-secret-modal";

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(locale, { month: "short", day: "2-digit", year: "numeric" });
}

export function WebhookEndpointsWorkspace({ canManage }: { canManage: boolean }) {
  const t = useTranslations();
  const locale = useLocale();
  const swr = usePersistedDashboardSWR<WebhookEndpointView[]>(
    ["webhook-endpoints"],
    fetchWebhookEndpoints,
    { revalidateOnFocus: true, revalidateIfStale: true },
    { key: "webhook-endpoints", ttlMs: 15_000 }
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<WebhookEndpointView | null>(null);
  const actions = useWebhookEndpointActions({ onChanged: () => void swr.mutate() });

  const endpoints = swr.data;

  if (swr.isLoading && !endpoints) {
    return <WebhookEndpointsListSkeleton />;
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-8 md:px-6">
      <div className="mx-auto w-full max-w-[1200px] py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium text-primary">{t("DashboardWebhooks.title")}</h1>
            <p className="mt-1 text-sm text-secondary">{t("DashboardWebhooks.description")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t("DashboardWebhooks.refresh")}
              onClick={() => void swr.mutate()}
            >
              <RefreshCwIcon />
            </Button>
            {canManage && (
              <Button
                type="button"
                size="sm"
                iconLeft={<PlusIcon className="size-4" />}
                onClick={() => setCreateOpen(true)}
              >
                {t("DashboardWebhooks.createEndpoint")}
              </Button>
            )}
          </div>
        </header>

        {swr.error && !endpoints ? (
          <div className="mt-6 rounded-xl border border-border-default p-8 text-center">
            <p className="text-sm text-secondary">{t("DashboardWebhooks.loadError")}</p>
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
        ) : !endpoints || endpoints.length === 0 ? (
          <div className="mt-6 rounded-xl border border-border-default p-8 text-center">
            <h2 className="text-base font-medium text-primary">
              {t("DashboardWebhooks.emptyTitle")}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-secondary">
              {t("DashboardWebhooks.emptyDescription")}
            </p>
            {canManage && (
              <Button
                type="button"
                size="sm"
                className="mt-4"
                iconLeft={<PlusIcon className="size-4" />}
                onClick={() => setCreateOpen(true)}
              >
                {t("DashboardWebhooks.createEndpoint")}
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-xl border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("DashboardWebhooks.columnLabel")}</TableHead>
                  <TableHead>{t("DashboardWebhooks.columnUrl")}</TableHead>
                  <TableHead>{t("DashboardWebhooks.columnStatus")}</TableHead>
                  <TableHead>{t("DashboardWebhooks.columnSecret")}</TableHead>
                  <TableHead>{t("DashboardWebhooks.columnCreated")}</TableHead>
                  <TableHead className="text-right">{t("DashboardWebhooks.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.map((endpoint) => (
                  <TableRow key={endpoint.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/webhooks/${encodeURIComponent(endpoint.id)}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {endpoint.label}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <span className="block truncate text-secondary" title={endpoint.url}>
                        {endpoint.url}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={endpoint.status === "active" ? "success" : "default"}>
                        {endpoint.status === "active"
                          ? t("DashboardWebhooks.statusActive")
                          : t("DashboardWebhooks.statusDisabled")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-secondary">
                        <LockIcon aria-hidden className="size-3.5" />
                        {t("DashboardWebhooks.secretConfigured")}
                      </span>
                    </TableCell>
                    <TableCell className="text-secondary">
                      {formatDate(endpoint.createdAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <WebhookEndpointActionsMenu
                        endpoint={endpoint}
                        canManage={canManage}
                        onEdit={setEditTarget}
                        onRotate={actions.requestRotate}
                        onToggle={actions.requestToggle}
                        onDelete={actions.requestDelete}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <CreateWebhookEndpointModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => {
          setCreateOpen(false);
          void swr.mutate();
          actions.setRevealedSecret({ secret: result.secret, context: "created" });
        }}
      />
      <EditWebhookEndpointModal
        endpoint={editTarget}
        onClose={() => setEditTarget(null)}
        onUpdated={() => {
          setEditTarget(null);
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
