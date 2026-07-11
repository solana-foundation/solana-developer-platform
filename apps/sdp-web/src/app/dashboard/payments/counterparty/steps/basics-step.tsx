"use client";

import { HashIcon, IdCardIcon, MailIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { EntityTypeToggle } from "../components/entity-type-toggle";
import { useCounterpartyCreate } from "../counterparty-create-context";

export function BasicsStep() {
  const t = useTranslations();
  const { basics } = useCounterpartyCreate();
  const { values, setField, errors } = basics;

  return (
    <div className="space-y-6">
      <EntityTypeToggle
        value={values.entityType}
        onChange={(next) => setField("entityType", next)}
      />

      <div className="space-y-2">
        <Label htmlFor="displayName">{t("DashboardPayments.counterparty.displayName")}</Label>
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
        {errors.displayName && (
          <p className="mt-1 text-xs text-status-error-text">{errors.displayName}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">{t("DashboardPayments.counterparty.email")}</Label>
        <Input
          size="xl"
          id="email"
          type="email"
          iconLeft={<MailIcon />}
          placeholder={t("DashboardPayments.counterparty.emailPlaceholder")}
          value={values.email}
          onChange={(e) => setField("email", e.target.value)}
        />
        {errors.email && <p className="mt-1 text-xs text-status-error-text">{errors.email}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="externalId">
          {t("DashboardPayments.counterparty.externalId")} {" "}
          <span className="font-normal text-text-extra-low">{t("DashboardPayments.counterparty.optional")}</span>
        </Label>
        <Input
          size="xl"
          id="externalId"
          iconLeft={<HashIcon />}
          placeholder={t("DashboardPayments.counterparty.externalIdPlaceholder")}
          value={values.externalId}
          onChange={(e) => setField("externalId", e.target.value)}
        />
        {errors.externalId && (
          <p className="mt-1 text-xs text-status-error-text">{errors.externalId}</p>
        )}
      </div>
    </div>
  );
}
