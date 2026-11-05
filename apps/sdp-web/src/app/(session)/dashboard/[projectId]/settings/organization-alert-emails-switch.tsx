"use client";

import { ToggleSwitch } from "@sdp/ui/toggle-switch";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { RecordActionRow } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { useTranslations } from "@/i18n/provider";
import { refreshKeepingDashboardUrl } from "@/lib/dashboard-url-state";
import { saveOrganizationAlertEmails } from "./organization-settings";

export function OrganizationAlertEmailsSwitch({
  organizationId,
  initialEnabled,
}: {
  organizationId: string;
  initialEnabled: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  // One key per intended value: a retried save repeats it, the other value gets a new one.
  const pendingSave = useRef<{ enabled: boolean; key: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (next: boolean) => {
    startTransition(async () => {
      if (pendingSave.current?.enabled !== next) {
        pendingSave.current = { enabled: next, key: crypto.randomUUID() };
      }
      const result = await saveOrganizationAlertEmails(
        organizationId,
        next,
        pendingSave.current.key
      );
      if (!result.ok) {
        toast.error(t("Shared.organizationAlertEmails.saveFailed", { error: result.error }));
        return;
      }
      setEnabled(result.value);
      pendingSave.current = null;
      // The tabs remount their panels from the page's server props, so those must hold the save.
      refreshKeepingDashboardUrl(router);
      toast.success(
        result.value
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
