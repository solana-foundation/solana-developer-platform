"use client";

import { Building2Icon, GlobeIcon, MapIcon, MapPinIcon, MapPinnedIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { AddressAutocomplete } from "../components/address-autocomplete";
import { useCounterpartyCreate } from "../counterparty-create-context";
import { useCounterpartyMetadata } from "../use-counterparty-metadata";

export function AddressStep() {
  const t = useTranslations();
  const { address } = useCounterpartyCreate();
  const { values, setField, errors } = address;
  const { metadata, loading, error } = useCounterpartyMetadata();

  const countryOptions = useMemo<ComboboxOption[]>(
    () =>
      (metadata?.countries ?? []).map((country) => ({
        value: country.code,
        label: country.name,
        description: country.code,
      })),
    [metadata]
  );

  const usStateOptions = useMemo<ComboboxOption[]>(
    () =>
      (metadata?.usStates ?? []).map((state) => ({
        value: state.code,
        label: state.name,
        description: state.code,
      })),
    [metadata]
  );

  const isUnitedStates = values.countryCode === "US";

  return (
    <div className="space-y-6">
      <AddressAutocomplete
        onSelect={(fields) => {
          setField("line1", fields.line1);
          setField("line2", fields.line2);
          setField("city", fields.city);
          setField("postalCode", fields.postalCode);
          setField("countryCode", fields.countryCode);
          setField("subdivisionCode", fields.subdivisionCode);
        }}
      />
      <div className="space-y-2">
        <Label htmlFor="line1">{t("DashboardPayments.counterparty.line1")}</Label>
        <Input
          size="xl"
          id="line1"
          iconLeft={<MapPinIcon />}
          placeholder={t("DashboardPayments.counterparty.line1Placeholder")}
          value={values.line1}
          onChange={(e) => setField("line1", e.target.value)}
        />
        {errors.line1 && <p className="mt-1 text-xs text-status-error-text">{errors.line1}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="line2">
          {t("DashboardPayments.counterparty.line2")}{" "}
          <span className="font-normal text-text-extra-low">
            {t("DashboardPayments.counterparty.optional")}
          </span>
        </Label>
        <Input
          size="xl"
          id="line2"
          iconLeft={<MapPinIcon />}
          placeholder={t("DashboardPayments.counterparty.line2Placeholder")}
          value={values.line2}
          onChange={(e) => setField("line2", e.target.value)}
        />
        {errors.line2 && <p className="mt-1 text-xs text-status-error-text">{errors.line2}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="city">{t("DashboardPayments.counterparty.city")}</Label>
          <Input
            size="xl"
            id="city"
            iconLeft={<Building2Icon />}
            placeholder={t("DashboardPayments.counterparty.cityPlaceholder")}
            value={values.city}
            onChange={(e) => setField("city", e.target.value)}
          />
          {errors.city && <p className="mt-1 text-xs text-status-error-text">{errors.city}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="postalCode">
            {t("DashboardPayments.counterparty.postalCode")}{" "}
            <span className="font-normal text-text-extra-low">
              {t("DashboardPayments.counterparty.optional")}
            </span>
          </Label>
          <Input
            size="xl"
            id="postalCode"
            iconLeft={<MapPinnedIcon />}
            placeholder="10001"
            value={values.postalCode}
            onChange={(e) => setField("postalCode", e.target.value)}
          />
          {errors.postalCode && (
            <p className="mt-1 text-xs text-status-error-text">{errors.postalCode}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Combobox
            label={t("DashboardPayments.counterparty.country")}
            value={values.countryCode || null}
            onChange={(next) => setField("countryCode", next)}
            options={countryOptions}
            placeholder={t("DashboardPayments.counterparty.selectCountry")}
            searchPlaceholder={t("DashboardPayments.counterparty.searchCountries")}
            icon={<GlobeIcon />}
            isLoading={loading}
            error={error ?? undefined}
          />
          {errors.countryCode && (
            <p className="mt-1 text-xs text-status-error-text">{errors.countryCode}</p>
          )}
        </div>
        <div className="space-y-2">
          {isUnitedStates ? (
            <Combobox
              label={t("DashboardPayments.counterparty.state")}
              value={values.subdivisionCode || null}
              onChange={(next) => setField("subdivisionCode", next)}
              options={usStateOptions}
              placeholder={t("DashboardPayments.counterparty.selectState")}
              searchPlaceholder={t("DashboardPayments.counterparty.searchStates")}
              icon={<MapIcon />}
              isLoading={loading}
              error={error ?? undefined}
            />
          ) : (
            <>
              <Label htmlFor="subdivisionCode">
                {t("DashboardPayments.counterparty.stateProvince")}{" "}
                <span className="font-normal text-text-extra-low">
                  {t("DashboardPayments.counterparty.optional")}
                </span>
              </Label>
              <Input
                size="xl"
                id="subdivisionCode"
                iconLeft={<MapIcon />}
                placeholder={t("DashboardPayments.counterparty.statePlaceholder")}
                value={values.subdivisionCode}
                onChange={(e) => setField("subdivisionCode", e.target.value)}
              />
            </>
          )}
          {errors.subdivisionCode && (
            <p className="mt-1 text-xs text-status-error-text">{errors.subdivisionCode}</p>
          )}
        </div>
      </div>
    </div>
  );
}
