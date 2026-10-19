"use client";

import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { HashIcon, IdCardIcon } from "lucide-react";
import { EntityTypeToggle } from "@/app/dashboard/[projectId]/payments/counterparty/components/entity-type-toggle";
import { useCounterpartyCreate } from "@/app/dashboard/[projectId]/payments/counterparty/counterparty-create-context";
import { useTranslations } from "@/i18n/provider";

export function BasicsStep() {
  const t = useTranslations();
  const { basics } = useCounterpartyCreate();
  const { values, setField, errors } = basics;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="displayName">{t("DashboardPayments.counterparty.displayName")}</Label>
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <Input
              size="xl"
              id="displayName"
              iconLeft={<IdCardIcon />}
              placeholder={t(
                values.entityType === "individual"
                  ? "DashboardPayments.counterparty.individualNamePlaceholder"
                  : "DashboardPayments.counterparty.businessNamePlaceholder"
              )}
              value={values.displayName}
              onChange={(e) => setField("displayName", e.target.value)}
            />
          </div>
          <EntityTypeToggle
            value={values.entityType}
            onChange={(next) => setField("entityType", next)}
          />
        </div>
        {errors.displayName && <p className="mt-1 text-xs text-error">{errors.displayName}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="externalId">
          {t("DashboardPayments.counterparty.externalId")}{" "}
          <span className="font-normal text-muted">
            {t("DashboardPayments.counterparty.optional")}
          </span>
        </Label>
        <Input
          size="xl"
          id="externalId"
          iconLeft={<HashIcon />}
          placeholder={t("DashboardPayments.counterparty.externalIdPlaceholder")}
          value={values.externalId}
          onChange={(e) => setField("externalId", e.target.value)}
        />
        {errors.externalId && <p className="mt-1 text-xs text-error">{errors.externalId}</p>}
      </div>
    </div>
  );
}
