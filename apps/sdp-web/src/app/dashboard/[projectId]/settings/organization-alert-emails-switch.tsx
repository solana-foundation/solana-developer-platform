"use client";

import { ToggleSwitch } from "@sdp/ui/toggle-switch";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { saveOrganizationAlertEmailsAction } from "./organization-access-actions";

export function OrganizationAlertEmailsSwitch({ initialEnabled }: { initialEnabled: boolean }) {
  const t = useTranslations();
  const [enabled, setEnabled] = useState(initialEnabled);
  // One key per intended value: a retried save repeats it, the other value gets a new one.
  const pendingSave = useRef<{ enabled: boolean; key: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (next: boolean) => {
    startTransition(async () => {
      if (pendingSave.current?.enabled !== next) {
        pendingSave.current = { enabled: next, key: crypto.randomUUID() };
      }
      const result = await saveOrganizationAlertEmailsAction(next, pendingSave.current.key);
      if (!result.ok) {
        toast.error(t("Shared.organizationAlertEmails.saveFailed", { error: result.error }));
        return;
      }
      setEnabled(result.enabled);
      pendingSave.current = null;
      toast.success(
        result.enabled
          ? t("Shared.organizationAlertEmails.savedOn")
          : t("Shared.organizationAlertEmails.savedOff")
      );
    });
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p id="organization-alert-emails-label" className="text-sm font-medium text-primary">
          {t("Shared.organizationAlertEmails.switchLabel")}
        </p>
        <p id="organization-alert-emails-helper" className="mt-1 text-xs text-secondary">
          {enabled
            ? t("Shared.organizationAlertEmails.onHelper")
            : t("Shared.organizationAlertEmails.offHelper")}
        </p>
      </div>
      <ToggleSwitch
        aria-labelledby="organization-alert-emails-label"
        aria-describedby="organization-alert-emails-helper"
        checked={enabled}
        onChange={save}
        disabled={isPending}
      />
    </div>
  );
}
