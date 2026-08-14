"use client";

import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { createWebhookEndpoint } from "./webhook-endpoints.client";
import type { CreateWebhookEndpointResult } from "./webhook-endpoints.data";
import { isValidWebhookEndpointUrl } from "./webhook-endpoints.data";

export function CreateWebhookEndpointModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  // The result carries the one-time secret; the parent lifts it into the reveal modal.
  onCreated: (result: CreateWebhookEndpointResult) => void;
}) {
  const t = useTranslations();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<{ label?: string; url?: string }>({});
  const [pending, setPending] = useState(false);

  const reset = () => {
    setLabel("");
    setUrl("");
    setDescription("");
    setErrors({});
  };

  const handleClose = () => {
    if (pending) {
      return;
    }
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    const nextErrors: { label?: string; url?: string } = {};
    if (!label.trim()) {
      nextErrors.label = t("DashboardWebhooks.validationLabelRequired");
    }
    if (!isValidWebhookEndpointUrl(url)) {
      nextErrors.url = t("DashboardWebhooks.validationUrlHttps");
    }
    setErrors(nextErrors);
    if (nextErrors.label || nextErrors.url) {
      return;
    }

    setPending(true);
    try {
      const result = await createWebhookEndpoint({
        url: url.trim(),
        label: label.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      toast.success(t("DashboardWebhooks.toastCreated"));
      reset();
      onCreated(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("DashboardWebhooks.errorCreate"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      closeDisabled={pending}
      ariaLabel={t("DashboardWebhooks.createTitle")}
      closeLabel={t("DashboardWebhooks.close")}
      contentClassName="border-border-default p-5"
      size="md"
    >
      <h4 className="pr-12 text-lg font-medium text-primary">
        {t("DashboardWebhooks.createTitle")}
      </h4>
      <p className="mt-1 text-sm text-secondary">{t("DashboardWebhooks.createDescription")}</p>

      <div className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="webhook-endpoint-label">{t("DashboardWebhooks.fieldLabel")}</Label>
          <Input
            id="webhook-endpoint-label"
            value={label}
            maxLength={120}
            placeholder={t("DashboardWebhooks.fieldLabelPlaceholder")}
            onChange={(event) => {
              setLabel(event.target.value);
              setErrors((prev) => (prev.label ? { ...prev, label: undefined } : prev));
            }}
            disabled={pending}
          />
          {errors.label && <p className="text-xs text-error">{errors.label}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="webhook-endpoint-url">{t("DashboardWebhooks.fieldUrl")}</Label>
          <Input
            id="webhook-endpoint-url"
            value={url}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={2_000}
            placeholder={t("DashboardWebhooks.fieldUrlPlaceholder")}
            onChange={(event) => {
              setUrl(event.target.value);
              setErrors((prev) => (prev.url ? { ...prev, url: undefined } : prev));
            }}
            disabled={pending}
          />
          {errors.url ? (
            <p className="text-xs text-error">{errors.url}</p>
          ) : (
            <p className="text-xs text-tertiary">{t("DashboardWebhooks.fieldUrlHelp")}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="webhook-endpoint-description">
            {t("DashboardWebhooks.fieldDescription")}
          </Label>
          <Input
            id="webhook-endpoint-description"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
            disabled={pending}
          />
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleClose} disabled={pending}>
          {t("DashboardWebhooks.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          iconLeft={<PlusIcon className="size-3.5" />}
          onClick={handleSubmit}
          disabled={pending}
        >
          {pending ? t("DashboardWebhooks.creating") : t("DashboardWebhooks.create")}
        </Button>
      </div>
    </Modal>
  );
}
