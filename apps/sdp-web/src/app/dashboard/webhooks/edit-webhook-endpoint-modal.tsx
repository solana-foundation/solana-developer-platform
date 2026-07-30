"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { updateWebhookEndpoint } from "./webhook-endpoints.client";
import type { WebhookEndpointView } from "./webhook-endpoints.data";

export function EditWebhookEndpointModal({
  endpoint,
  onClose,
  onUpdated,
}: {
  endpoint: WebhookEndpointView | null;
  onClose: () => void;
  onUpdated: (endpoint: WebhookEndpointView) => void;
}) {
  const t = useTranslations();
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (endpoint) {
      setLabel(endpoint.label);
      setDescription(endpoint.description ?? "");
      setLabelError(null);
    }
  }, [endpoint]);

  if (!endpoint) {
    return null;
  }

  const handleSubmit = async () => {
    if (!label.trim()) {
      setLabelError(t("DashboardWebhooks.validationLabelRequired"));
      return;
    }
    setPending(true);
    try {
      const updated = await updateWebhookEndpoint(endpoint.id, {
        label: label.trim(),
        description: description.trim() ? description.trim() : null,
      });
      toast.success(t("DashboardWebhooks.toastUpdated"));
      onUpdated(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("DashboardWebhooks.errorUpdate"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={pending ? undefined : onClose}
      closeDisabled={pending}
      ariaLabel={t("DashboardWebhooks.editTitle")}
      closeLabel={t("DashboardWebhooks.close")}
      contentClassName="border-border-default p-5"
      size="md"
    >
      <h4 className="pr-12 text-lg font-medium text-primary">{t("DashboardWebhooks.editTitle")}</h4>
      <p className="mt-1 text-sm text-secondary">{t("DashboardWebhooks.editDescription")}</p>

      <div className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="webhook-edit-url">{t("DashboardWebhooks.fieldUrl")}</Label>
          <Input id="webhook-edit-url" value={endpoint.url} readOnly disabled />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="webhook-edit-label">{t("DashboardWebhooks.fieldLabel")}</Label>
          <Input
            id="webhook-edit-label"
            value={label}
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            disabled={pending}
          />
          {labelError && <p className="text-xs text-error">{labelError}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="webhook-edit-description">
            {t("DashboardWebhooks.fieldDescription")}
          </Label>
          <Input
            id="webhook-edit-description"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
            disabled={pending}
          />
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
          {t("DashboardWebhooks.cancel")}
        </Button>
        <Button type="button" size="sm" onClick={handleSubmit} disabled={pending}>
          {pending ? t("DashboardWebhooks.saving") : t("DashboardWebhooks.saveChanges")}
        </Button>
      </div>
    </Modal>
  );
}
