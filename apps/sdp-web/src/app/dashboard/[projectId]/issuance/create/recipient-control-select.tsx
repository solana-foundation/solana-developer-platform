"use client";

import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import type { AccessControlMode } from "./issuance-draft-wizard.types";

export function RecipientControlSelect({
  value,
  disabled,
  onChange,
}: {
  value: AccessControlMode | "";
  disabled: boolean;
  onChange: (value: AccessControlMode | "") => void;
}) {
  const t = useTranslations();
  if (disabled)
    return (
      <div className="flex flex-wrap justify-between gap-3 py-3 text-sm">
        <span className="text-tertiary">{t("DashboardIssuance.simplified.recipients")}</span>
        <span className="text-primary">
          {t(
            value === "allowlist"
              ? "DashboardIssuance.ux.approvedOnly"
              : value === "blocklist"
                ? "DashboardIssuance.ux.exceptBlocked"
                : "DashboardIssuance.simplified.anyRecipient"
          )}
        </span>
      </div>
    );
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-primary">
        {t("DashboardIssuance.simplified.recipients")}
      </p>
      <Select
        ariaLabel={t("DashboardIssuance.simplified.recipients")}
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(next as AccessControlMode)}
      >
        <SelectItem value="disabled">{t("DashboardIssuance.simplified.anyRecipient")}</SelectItem>
        <SelectItem value="allowlist">
          {t("DashboardIssuance.simplified.approvedRecipients")}
        </SelectItem>
        <SelectItem value="blocklist">
          {t("DashboardIssuance.simplified.blockedRecipients")}
        </SelectItem>
      </Select>
    </div>
  );
}
