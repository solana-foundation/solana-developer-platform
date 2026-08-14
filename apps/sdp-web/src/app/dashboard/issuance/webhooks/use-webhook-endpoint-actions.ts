"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import type { WebhookConfirmState } from "./confirm-webhook-action-modal";
import {
  deleteWebhookEndpoint,
  rotateWebhookEndpointSecret,
  updateWebhookEndpoint,
} from "./webhook-endpoints.client";
import type { WebhookEndpointView } from "./webhook-endpoints.data";
import type { RevealedWebhookSecret } from "./webhook-secret-modal";

const ROTATION_GRACE_HOURS = 24;

// Rotate / enable / disable / delete flows shared by the list and the detail page:
// confirm-dialog state, the async calls, toasts, and the one-time secret reveal.
export function useWebhookEndpointActions({
  onChanged,
  onDeleted,
}: {
  onChanged: () => void;
  onDeleted?: (endpoint: WebhookEndpointView) => void;
}) {
  const t = useTranslations();
  const [confirm, setConfirm] = useState<WebhookConfirmState | null>(null);
  const [pending, setPending] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<RevealedWebhookSecret | null>(null);

  const runConfirmed = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
      setConfirm(null);
    } finally {
      setPending(false);
    }
  };

  const requestRotate = (endpoint: WebhookEndpointView) => {
    setConfirm({
      title: t("DashboardWebhooks.rotateConfirmTitle"),
      description: t("DashboardWebhooks.rotateConfirmDescription", {
        hours: ROTATION_GRACE_HOURS,
      }),
      confirmLabel: t("DashboardWebhooks.confirmRotate"),
      onConfirm: () =>
        void runConfirmed(async () => {
          try {
            const result = await rotateWebhookEndpointSecret(endpoint.id, ROTATION_GRACE_HOURS);
            toast.success(t("DashboardWebhooks.toastSecretRotated"));
            setRevealedSecret({
              secret: result.secret,
              context: "rotated",
              previousSecretExpiresAt: result.previousSecretExpiresAt,
            });
            onChanged();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t("DashboardWebhooks.errorRotate"));
          }
        }),
    });
  };

  const setStatus = async (endpoint: WebhookEndpointView, status: "active" | "disabled") => {
    try {
      await updateWebhookEndpoint(endpoint.id, { status });
      toast.success(
        status === "active"
          ? t("DashboardWebhooks.toastEnabled")
          : t("DashboardWebhooks.toastDisabled")
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("DashboardWebhooks.errorUpdate"));
    }
  };

  const requestToggle = (endpoint: WebhookEndpointView) => {
    if (endpoint.status === "disabled") {
      // Re-enabling is harmless; only disabling (breaking live rules) needs a confirm.
      void setStatus(endpoint, "active");
      return;
    }
    setConfirm({
      title: t("DashboardWebhooks.disableConfirmTitle"),
      description: t("DashboardWebhooks.disableConfirmDescription"),
      confirmLabel: t("DashboardWebhooks.confirmDisable"),
      destructive: true,
      onConfirm: () => void runConfirmed(() => setStatus(endpoint, "disabled")),
    });
  };

  const requestDelete = (endpoint: WebhookEndpointView) => {
    setConfirm({
      title: t("DashboardWebhooks.deleteConfirmTitle"),
      description: t("DashboardWebhooks.deleteConfirmDescription"),
      confirmLabel: t("DashboardWebhooks.confirmDelete"),
      destructive: true,
      onConfirm: () =>
        void runConfirmed(async () => {
          try {
            const result = await deleteWebhookEndpoint(endpoint.id);
            toast.success(
              result.referencingWorkflows > 0
                ? t("DashboardWebhooks.toastDeletedReferencing", {
                    count: result.referencingWorkflows,
                  })
                : t("DashboardWebhooks.toastDeleted")
            );
            onChanged();
            onDeleted?.(endpoint);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t("DashboardWebhooks.errorDelete"));
          }
        }),
    });
  };

  return {
    confirm,
    pending,
    revealedSecret,
    setRevealedSecret,
    cancelConfirm: () => setConfirm(null),
    closeSecret: () => setRevealedSecret(null),
    requestRotate,
    requestToggle,
    requestDelete,
  };
}
