"use client";

import { ChevronDown } from "lucide-react";
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
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="rounded-full px-5 whitespace-nowrap"
          iconRight={<ChevronDown className="size-4" />}
        >
          {t("DashboardWebhooks.actions")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <DropdownMenuItem
          onSelect={() => router.push(`/dashboard/webhooks/${encodeURIComponent(endpoint.id)}`)}
        >
          {t("DashboardWebhooks.viewEndpoint")}
        </DropdownMenuItem>
        {canManage && (
          <>
            <DropdownMenuItem onSelect={() => onEdit(endpoint)}>
              {t("DashboardWebhooks.editEndpoint")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onRotate(endpoint)}>
              {t("DashboardWebhooks.rotateSecret")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onToggle(endpoint)}>
              {endpoint.status === "active"
                ? t("DashboardWebhooks.disable")
                : t("DashboardWebhooks.enable")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              onSelect={() => onDelete(endpoint)}
            >
              {t("DashboardWebhooks.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
