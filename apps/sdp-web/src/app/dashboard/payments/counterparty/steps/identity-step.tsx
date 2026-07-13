"use client";

import { CalendarIcon, PhoneIcon, UserIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { useCounterpartyCreate } from "../counterparty-create-context";

export function IdentityStep() {
  const t = useTranslations();
  const { identity } = useCounterpartyCreate();
  const { values, setField, errors } = identity;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="firstName">{t("DashboardPayments.counterparty.firstName")}</Label>
          <Input
            size="xl"
            id="firstName"
            iconLeft={<UserIcon />}
            placeholder={t("DashboardPayments.counterparty.firstNamePlaceholder")}
            value={values.firstName}
            onChange={(e) => setField("firstName", e.target.value)}
          />
          {errors.firstName && (
            <p className="mt-1 text-xs text-status-error-text">{errors.firstName}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName">{t("DashboardPayments.counterparty.lastName")}</Label>
          <Input
            size="xl"
            id="lastName"
            iconLeft={<UserIcon />}
            placeholder={t("DashboardPayments.counterparty.lastNamePlaceholder")}
            value={values.lastName}
            onChange={(e) => setField("lastName", e.target.value)}
          />
          {errors.lastName && (
            <p className="mt-1 text-xs text-status-error-text">{errors.lastName}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="dateOfBirth">{t("DashboardPayments.counterparty.dateOfBirth")}</Label>
          <Input
            size="xl"
            id="dateOfBirth"
            type="date"
            iconLeft={<CalendarIcon />}
            value={values.dateOfBirth}
            onChange={(e) => setField("dateOfBirth", e.target.value)}
          />
          {errors.dateOfBirth && (
            <p className="mt-1 text-xs text-status-error-text">{errors.dateOfBirth}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">{t("DashboardPayments.counterparty.phone")}</Label>
          <Input
            size="xl"
            id="phone"
            type="tel"
            iconLeft={<PhoneIcon />}
            placeholder={t("DashboardPayments.counterparty.phonePlaceholder")}
            value={values.phone}
            onChange={(e) => setField("phone", e.target.value)}
          />
          {errors.phone && <p className="mt-1 text-xs text-status-error-text">{errors.phone}</p>}
        </div>
      </div>
    </div>
  );
}
