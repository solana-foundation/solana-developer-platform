"use client";

import {
  BanknoteIcon,
  BriefcaseIcon,
  FactoryIcon,
  FileTextIcon,
  FlagIcon,
  GlobeIcon,
  ShieldCheckIcon,
  TargetIcon,
  TrendingUpIcon,
  WalletIcon,
} from "lucide-react";
import { useMemo } from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { humanizeEnumLabel } from "@/lib/utils";
import { useCounterpartyCreate } from "../counterparty-create-context";
import { useCounterpartyMetadata } from "../use-counterparty-metadata";

function toOptions(values: readonly string[]): ComboboxOption[] {
  return values.map((value) => ({ value, label: humanizeEnumLabel(value) }));
}

export function ComplianceStep() {
  const { compliance } = useCounterpartyCreate();
  const { values, setField, errors } = compliance;
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

  const cdd = metadata?.compliance;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="taxIdNumber">Tax identification number (SSN / ITIN)</Label>
        <Input
          size="xl"
          id="taxIdNumber"
          iconLeft={<FileTextIcon />}
          placeholder="123-45-6789"
          value={values.taxIdNumber}
          onChange={(e) => setField("taxIdNumber", e.target.value)}
        />
        {errors.taxIdNumber && (
          <p className="mt-1 text-xs text-status-error-text">{errors.taxIdNumber}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Combobox
            label="Nationality"
            value={values.nationality || null}
            onChange={(next) => setField("nationality", next)}
            options={countryOptions}
            placeholder="Select country"
            searchPlaceholder="Search countries…"
            icon={<FlagIcon />}
            isLoading={loading}
            error={error ?? undefined}
          />
          {errors.nationality && (
            <p className="mt-1 text-xs text-status-error-text">{errors.nationality}</p>
          )}
        </div>
        <div className="space-y-2">
          <Combobox
            label="Country of birth"
            value={values.birthCountryCode || null}
            onChange={(next) => setField("birthCountryCode", next)}
            options={countryOptions}
            placeholder="Select country"
            searchPlaceholder="Search countries…"
            icon={<GlobeIcon />}
            isLoading={loading}
            error={error ?? undefined}
          />
          {errors.birthCountryCode && (
            <p className="mt-1 text-xs text-status-error-text">{errors.birthCountryCode}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Combobox
            label="Employment status"
            value={values.employmentStatus || null}
            onChange={(next) => setField("employmentStatus", next)}
            options={toOptions(cdd?.employmentStatuses ?? [])}
            placeholder="Select"
            searchable={false}
            icon={<BriefcaseIcon />}
            isLoading={loading}
          />
          {errors.employmentStatus && (
            <p className="mt-1 text-xs text-status-error-text">{errors.employmentStatus}</p>
          )}
        </div>
        <div className="space-y-2">
          <Combobox
            label="Source of funds"
            value={values.sourceOfFunds || null}
            onChange={(next) => setField("sourceOfFunds", next)}
            options={toOptions(cdd?.sourceOfFunds ?? [])}
            placeholder="Select"
            searchable={false}
            icon={<BanknoteIcon />}
            isLoading={loading}
          />
          {errors.sourceOfFunds && (
            <p className="mt-1 text-xs text-status-error-text">{errors.sourceOfFunds}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Combobox
            label="PEP status"
            value={values.pepStatus || null}
            onChange={(next) => setField("pepStatus", next)}
            options={toOptions(cdd?.pepStatuses ?? [])}
            placeholder="Select"
            searchable={false}
            icon={<ShieldCheckIcon />}
            isLoading={loading}
          />
          {errors.pepStatus && (
            <p className="mt-1 text-xs text-status-error-text">{errors.pepStatus}</p>
          )}
        </div>
        <div className="space-y-2">
          <Combobox
            label="Intended use of account"
            value={values.intendedUseOfAccount || null}
            onChange={(next) => setField("intendedUseOfAccount", next)}
            options={toOptions(cdd?.intendedUseOfAccount ?? [])}
            placeholder="Select"
            searchable={false}
            icon={<TargetIcon />}
            isLoading={loading}
          />
          {errors.intendedUseOfAccount && (
            <p className="mt-1 text-xs text-status-error-text">{errors.intendedUseOfAccount}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Combobox
            label="Estimated yearly income"
            value={values.estimatedYearlyIncome || null}
            onChange={(next) => setField("estimatedYearlyIncome", next)}
            options={toOptions(cdd?.estimatedYearlyIncome ?? [])}
            placeholder="Select"
            searchable={false}
            icon={<TrendingUpIcon />}
            isLoading={loading}
          />
          {errors.estimatedYearlyIncome && (
            <p className="mt-1 text-xs text-status-error-text">{errors.estimatedYearlyIncome}</p>
          )}
        </div>
        <div className="space-y-2">
          <Combobox
            label="Industry sector"
            value={values.employmentIndustrySector || null}
            onChange={(next) => setField("employmentIndustrySector", next)}
            options={toOptions(cdd?.employmentIndustrySectors ?? [])}
            placeholder="Select"
            searchPlaceholder="Search sectors…"
            icon={<FactoryIcon />}
            isLoading={loading}
          />
          {errors.employmentIndustrySector && (
            <p className="mt-1 text-xs text-status-error-text">{errors.employmentIndustrySector}</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="expectedMonthlyVolume">Expected monthly volume (USD)</Label>
        <Input
          size="xl"
          id="expectedMonthlyVolume"
          type="number"
          inputMode="decimal"
          iconLeft={<WalletIcon />}
          placeholder="1000"
          value={values.expectedMonthlyVolume}
          onChange={(e) => setField("expectedMonthlyVolume", e.target.value)}
        />
        {errors.expectedMonthlyVolume && (
          <p className="mt-1 text-xs text-status-error-text">{errors.expectedMonthlyVolume}</p>
        )}
      </div>
    </div>
  );
}
