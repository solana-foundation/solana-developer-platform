"use client";

import {
  EyeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/i18n/provider";
import type { WebhookEndpointView } from "./webhook-endpoints.data";

export function WebhookEndpointActionsMenu({
  endpoint,
  canManage,
  onEdit,
  onRotate,
  onToggle,
  onDelete,
}: {
  endpoint: WebhookEndpointView;
  canManage: boolean;
  onEdit: (endpoint: WebhookEndpointView) => void;
  onRotate: (endpoint: WebhookEndpointView) => void;
  onToggle: (endpoint: WebhookEndpointView) => void;
  onDelete: (endpoint: WebhookEndpointView) => void;
}) {
  const t = useTranslations();
  const router = useRouter();

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* The row-actions grammar used across the dashboard (members, counterparties,
            policies): an icon-only overflow trigger, named for assistive tech only. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("DashboardWebhooks.actions")}
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <DropdownMenuItem
          className="gap-2"
          onSelect={() =>
            router.push(`/dashboard/issuance/webhooks/${encodeURIComponent(endpoint.id)}`)
          }
        >
          <EyeIcon aria-hidden className="size-4 text-secondary" />
          {t("DashboardWebhooks.viewEndpoint")}
        </DropdownMenuItem>
        {canManage && (
          <>
            <DropdownMenuItem className="gap-2" onSelect={() => onEdit(endpoint)}>
              <PencilIcon aria-hidden className="size-4 text-secondary" />
              {t("DashboardWebhooks.editEndpoint")}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onSelect={() => onRotate(endpoint)}>
              <RefreshCwIcon aria-hidden className="size-4 text-secondary" />
              {t("DashboardWebhooks.rotateSecret")}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onSelect={() => onToggle(endpoint)}>
              {endpoint.status === "active" ? (
                <PowerOffIcon aria-hidden className="size-4 text-secondary" />
              ) : (
                <PowerIcon aria-hidden className="size-4 text-secondary" />
              )}
              {endpoint.status === "active"
                ? t("DashboardWebhooks.disable")
                : t("DashboardWebhooks.enable")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
              onSelect={() => onDelete(endpoint)}
            >
              <Trash2Icon aria-hidden className="size-4" />
              {t("DashboardWebhooks.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
