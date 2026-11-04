"use client";

import { ToggleSwitch } from "@sdp/ui/toggle-switch";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { RecordActionRow } from "@/app/dashboard/[projectId]/payments/payments-record";
import { useTranslations } from "@/i18n/provider";
import type { saveOrganizationAlertEmailsAction } from "./organization-access-actions";

/** The save is passed in by the server card, so tests hand it a stand-in through the same prop. */
export function OrganizationAlertEmailsSwitch({
  initialEnabled,
  save: saveSetting,
}: {
  initialEnabled: boolean;
  save: typeof saveOrganizationAlertEmailsAction;
}) {
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
      const result = await saveSetting(next, pendingSave.current.key);
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
    <RecordActionRow
      label={
        <span id="organization-alert-emails-label">
          {t("Shared.organizationAlertEmails.switchLabel")}
        </span>
      }
      help={t("Shared.organizationAlertEmails.description")}
      hint={
        <span id="organization-alert-emails-helper">
          {enabled
            ? t("Shared.organizationAlertEmails.onHelper")
            : t("Shared.organizationAlertEmails.offHelper")}
        </span>
      }
      control={
        <span className="flex items-center gap-3">
          <span aria-hidden="true" className="text-body text-secondary">
            {enabled
              ? t("Shared.organizationAlertEmails.stateOn")
              : t("Shared.organizationAlertEmails.stateOff")}
          </span>
          <ToggleSwitch
            aria-labelledby="organization-alert-emails-label"
            aria-describedby="organization-alert-emails-helper"
            checked={enabled}
            onChange={save}
            disabled={isPending}
          />
        </span>
      }
    />
  );
}
