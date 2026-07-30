"use client";

import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { GeneratedApiKeyInput } from "@/app/dashboard/api-keys/generated-key-input";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";

export interface RevealedWebhookSecret {
  secret: string;
  context: "created" | "rotated";
  previousSecretExpiresAt?: string | null;
}

// One-time reveal after create/rotate. The plaintext lives only in the parent's
// component state (create/rotate happen client-side with no navigation, so the
// api-keys cookie-flash machinery isn't needed) and is gone once dismissed.
export function WebhookSecretModal({
  revealed,
  onClose,
}: {
  revealed: RevealedWebhookSecret | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { copied, copy } = useCopy();

  if (!revealed) {
    return null;
  }

  const title =
    revealed.context === "created"
      ? t("DashboardWebhooks.secretCreatedTitle")
      : t("DashboardWebhooks.secretRotatedTitle");
  const graceExpiresAt = revealed.previousSecretExpiresAt
    ? new Date(revealed.previousSecretExpiresAt)
    : null;

  return (
    <Modal
      isOpen
      onClose={onClose}
      ariaLabel={title}
      size="md"
      contentClassName="border-border-default p-5"
    >
      <h4 className="pr-12 text-lg font-medium text-primary">{title}</h4>
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <p className="text-sm text-primary">{t("DashboardWebhooks.secretShownOnce")}</p>
      </div>
      <div className="mt-4">
        <span className="text-xs font-medium text-secondary">
          {t("DashboardWebhooks.secretLabel")}
        </span>
        <div className="mt-1 flex items-center gap-2">
          <GeneratedApiKeyInput value={revealed.secret} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copy(revealed.secret)}
            iconLeft={copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          >
            {copied ? t("DashboardWebhooks.copied") : t("DashboardWebhooks.copy")}
          </Button>
        </div>
      </div>
      {revealed.context === "rotated" && graceExpiresAt && (
        <p className="mt-3 text-sm text-secondary">
          {t("DashboardWebhooks.secretGraceNote", {
            expiresAt: graceExpiresAt.toLocaleString(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      )}
      <div className="mt-5 flex justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          {t("DashboardWebhooks.done")}
        </Button>
      </div>
    </Modal>
  );
}
