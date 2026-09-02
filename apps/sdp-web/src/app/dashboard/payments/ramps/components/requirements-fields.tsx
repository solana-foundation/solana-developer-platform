"use client";

import type { PlaceSuggestion, ResolvedPlace } from "@sdp/types";
import { COUNTRIES } from "@sdp/types/countries";
import { regionFlagEmoji } from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";
import {
  type CollectedFieldData,
  type PayoutRequirementAccount,
  type RequirementField,
  requirementFieldName,
} from "@sdp/types/ramp-requirements";
import { Loader2Icon, MapPinIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { autocompletePlaces, fetchPlaceDetails, newPlacesSessionToken } from "@/lib/places";
import { cn } from "@/lib/utils";
import { applyRequirementMask, requirementFieldError } from "../schema";

/**
 * The last selectable calendar day for an exclusive `before` bound, for the
 * native date input's inclusive `max` attribute.
 *
 * @param before - Exclusive ISO upper bound (YYYY-MM-DD).
 * @returns The ISO day immediately preceding `before`.
 */
function lastDateBefore(before: string): string {
  const date = new Date(`${before}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

type AddressRequirementField = Extract<RequirementField, { kind: "address" }>;

interface RequirementGroupCopy {
  title: MessageKey;
  description: MessageKey;
}

/**
 * Section copy for grouped collect forms, discriminated by provider then by
 * the fields' top-level dotted key segment (plus the wizard-synthesized
 * destination selects). Grouping is opt-in per provider: providers without an
 * entry render their dotted fields ungrouped, while an opted-in provider must
 * cover every group slug it emits.
 */
const REQUIREMENT_GROUP_COPY: Partial<
  Record<RampProviderId, Record<string, RequirementGroupCopy>>
> = {
  lightspark: {
    destination: {
      title: "DashboardPayments.ramps.requirementGroupDestinationTitle",
      description: "DashboardPayments.ramps.requirementGroupDestinationDescription",
    },
    bankAccount: {
      title: "DashboardPayments.ramps.requirementGroupBankAccountTitle",
      description: "DashboardPayments.ramps.requirementGroupBankAccountDescription",
    },
    customer: {
      title: "DashboardPayments.ramps.requirementGroupCustomerTitle",
      description: "DashboardPayments.ramps.requirementGroupCustomerDescription",
    },
  },
};

/**
 * Resolves the section a requirement field renders under: the key's top-level
 * dotted segment, or the destination section for the wizard-synthesized
 * country and rail selects. Flat keys with no section render ungrouped.
 *
 * @param field - Requirement field to place.
 * @returns The section slug, or null for ungrouped fields.
 */
function requirementFieldGroup(field: RequirementField): string | null {
  const separator = field.key.indexOf(".");
  if (separator !== -1) {
    return field.key.slice(0, separator);
  }
  if (field.key === "destinationCountry" || field.key === "paymentRails") {
    return "destination";
  }
  return null;
}

/**
 * Looks up the translated title/description pair for an opted-in provider's
 * requirement section.
 *
 * @param providerCopy - The provider's section copy map.
 * @param group - Section slug derived from the field keys.
 * @returns Message keys for the section's card header.
 */
function requirementGroupCopy(
  providerCopy: Record<string, RequirementGroupCopy>,
  group: string
): RequirementGroupCopy {
  const copy = providerCopy[group];
  if (copy === undefined) {
    throw new Error(`Requirement group "${group}" has no section copy.`);
  }
  return copy;
}

interface RequirementFieldRun {
  group: string | null;
  fields: RequirementField[];
}

/**
 * Partitions the flat field list into consecutive runs sharing a section,
 * preserving provider field order. Address fields always run alone since they
 * render their own card.
 *
 * @param fields - Flat requirement fields in provider order.
 * @returns Ordered field runs for card rendering.
 */
function requirementFieldRuns(fields: RequirementField[]): RequirementFieldRun[] {
  const runs: RequirementFieldRun[] = [];
  for (const field of fields) {
    if (field.kind === "address") {
      runs.push({ group: null, fields: [field] });
      continue;
    }
    const group = requirementFieldGroup(field);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.group === group && last.fields[0].kind !== "address") {
      last.fields.push(field);
      continue;
    }
    runs.push({ group, fields: [field] });
  }
  return runs;
}

/**
 * Copies resolved address values into matching nested requirement fields.
 *
 * @param field - Address requirement containing the nested fields to update.
 * @param place - Place details returned by the Places API.
 * @param onChange - Form callback used to update a collected field.
 * @returns Nothing.
 */
function populateAddressFields(
  field: AddressRequirementField,
  place: ResolvedPlace,
  onChange: (key: string, value: string) => void
): void {
  const addressFields = new Map(Object.entries(place.addressFields));
  for (const part of field.fields) {
    const value = addressFields.get(requirementFieldName(part.key));
    if (value === undefined) {
      continue;
    }
    onChange(part.key, value);
  }
}

const COUNTRY_FIELD_OPTIONS = COUNTRIES.map((country) => {
  const flag = regionFlagEmoji(country.code);
  if (flag === null) {
    throw new Error(`Country ${country.code} has no region flag emoji.`);
  }
  return { value: country.code, label: `${flag} ${country.name}` };
});

function RequirementFieldInput({
  field,
  value,
  onChange,
}: {
  field: RequirementField;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations();
  switch (field.kind) {
    case "select":
    case "country":
      return (
        <Combobox
          label={field.label}
          value={value.length > 0 ? value : null}
          onChange={onChange}
          options={field.kind === "select" ? field.options : COUNTRY_FIELD_OPTIONS}
          placeholder={t("DashboardPayments.ramps.selectField", {
            field: field.label.toLowerCase(),
          })}
          searchPlaceholder={t("DashboardPayments.ramps.search")}
        />
      );
    case "text": {
      const error = value.trim().length > 0 ? requirementFieldError(field, value) : null;
      return (
        <div className="space-y-2">
          <Label htmlFor={field.key}>{field.label}</Label>
          <Input
            size="xl"
            id={field.key}
            placeholder={field.placeholder}
            value={value}
            onChange={(event) =>
              onChange(
                field.mask
                  ? applyRequirementMask(field.mask, event.target.value)
                  : event.target.value
              )
            }
          />
          {error ? <p className="text-sm text-error">{error}</p> : null}
        </div>
      );
    }
    case "date": {
      const error = value.trim().length > 0 ? requirementFieldError(field, value) : null;
      return (
        <div className="space-y-2">
          <Label htmlFor={field.key}>{field.label}</Label>
          <Input
            size="xl"
            id={field.key}
            type="date"
            max={field.before === undefined ? undefined : lastDateBefore(field.before)}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          {error ? <p className="text-sm text-error">{error}</p> : null}
        </div>
      );
    }
    case "address":
      throw new Error(`Address field "${field.key}" renders through its nested fields.`);
    default: {
      const exhaustive: never = field;
      throw new Error(`Unhandled requirement field kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Renders an address requirement with Places autocomplete and editable parts.
 *
 * @param field - Address requirement to render.
 * @param onChange - Form callback used to update a collected field.
 * @param values - Current collected field values.
 * @returns The address card.
 */
function AddressRequirementField({
  field,
  onChange,
  values,
}: {
  field: AddressRequirementField;
  onChange: (key: string, value: string) => void;
  values: CollectedFieldData;
}) {
  const t = useTranslations();
  const searchId = useId();
  const listId = `${searchId}-suggestions`;
  const selectedAddressRef = useRef<string | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState(() => newPlacesSessionToken());

  useEffect(() => {
    const query = searchValue.trim();
    if (query.length === 0 || isResolving) {
      return;
    }
    if (selectedAddressRef.current === searchValue) {
      selectedAddressRef.current = null;
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setIsSearching(true);
      void autocompletePlaces(query, sessionToken)
        .then((nextSuggestions) => {
          if (cancelled) {
            return;
          }
          setSuggestions(nextSuggestions);
          setActiveIndex(nextSuggestions.length === 1 ? 0 : -1);
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          setSuggestions([]);
          setError(t("DashboardPayments.ramps.addressAutocompleteFailed"));
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearching(false);
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isResolving, searchValue, sessionToken, t]);

  async function handleSuggestionSelect(suggestion: PlaceSuggestion): Promise<void> {
    selectedAddressRef.current = searchValue;
    setIsResolving(true);
    setIsSearching(false);
    setSuggestions([]);
    setActiveIndex(-1);
    setError(null);
    try {
      const place = await fetchPlaceDetails(suggestion.placeId, sessionToken);
      populateAddressFields(field, place, onChange);
      selectedAddressRef.current = place.formattedAddress;
      setSearchValue(place.formattedAddress);
    } catch {
      setError(t("DashboardPayments.ramps.addressDetailsFailed"));
    } finally {
      setSessionToken(newPlacesSessionToken());
      setIsResolving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          <MapPinIcon className="size-5 shrink-0 text-tertiary" aria-hidden="true" />
          {field.label}
        </CardTitle>
        <CardDescription>
          {t("DashboardPayments.ramps.addressRequirementDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Label htmlFor={searchId} className="sr-only">
            {t("DashboardPayments.ramps.addressSearchPlaceholder")}
          </Label>
          <Input
            id={searchId}
            size="xl"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={suggestions.length > 0}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
            aria-busy={isSearching || isResolving}
            aria-describedby={error ? `${searchId}-error` : undefined}
            value={searchValue}
            placeholder={t("DashboardPayments.ramps.addressSearchPlaceholder")}
            iconLeft={<SearchIcon aria-hidden="true" />}
            iconRight={
              isSearching || isResolving ? (
                <Loader2Icon className="animate-spin" aria-hidden="true" />
              ) : null
            }
            disabled={isResolving}
            className="border border-[var(--input-border-idle)] bg-[var(--input-bg-idle)] hover:border-[var(--input-border-hover)] hover:bg-[var(--input-bg-hover)] focus:border-[var(--input-border-focus)]"
            onChange={(event) => {
              selectedAddressRef.current = null;
              setSearchValue(event.target.value);
              setSuggestions([]);
              setActiveIndex(-1);
              setIsSearching(false);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) =>
                  suggestions.length === 0 ? -1 : Math.min(current + 1, suggestions.length - 1)
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) =>
                  suggestions.length === 0 ? -1 : Math.max(current - 1, 0)
                );
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSuggestions([]);
                setActiveIndex(-1);
                return;
              }
              if (event.key === "Enter" && activeIndex >= 0) {
                const suggestion = suggestions[activeIndex];
                if (suggestion === undefined) {
                  return;
                }
                event.preventDefault();
                void handleSuggestionSelect(suggestion);
              }
            }}
          />
          {suggestions.length > 0 ? (
            <div
              id={listId}
              role="listbox"
              className="absolute z-10 mt-2 max-h-60 w-full overflow-y-auto rounded-[var(--select-popup-radius)] bg-[var(--select-popup-bg)] p-1.5 shadow-[var(--select-popup-shadow)]"
            >
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.placeId}
                  id={`${listId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-[var(--select-item-radius)] px-3 py-2.5 text-left text-sm text-primary transition-colors",
                    index === activeIndex && "bg-[var(--input-bg-hover)]",
                    index !== activeIndex && "hover:bg-[var(--input-bg-hover)]"
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void handleSuggestionSelect(suggestion)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{suggestion.mainText}</span>
                    {suggestion.secondaryText ? (
                      <span className="block truncate text-tertiary">
                        {suggestion.secondaryText}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {error ? (
            <p id={`${searchId}-error`} role="alert" className="mt-2 text-sm text-error">
              {error}
            </p>
          ) : null}
        </div>
        {field.fields.map((part) => (
          <RequirementFieldInput
            key={part.key}
            field={part}
            value={values[part.key] === undefined ? "" : values[part.key]}
            onChange={(value) => onChange(part.key, value)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Renders the current dynamic requirement field set.
 *
 * @param provider - Selected ramp provider, used to resolve section copy.
 * @param fields - Fields currently required by the provider and local selections.
 * @param values - Collected values keyed by requirement field.
 * @param onChange - Callback for updating a collected value.
 * @param existingPayoutAccount - Active corridor account selected for reuse.
 * @returns The requirement field group.
 */
export function RequirementsFields({
  provider,
  fields,
  values,
  onChange,
  existingPayoutAccount,
}: {
  provider: RampProviderId | null;
  fields: RequirementField[];
  values: CollectedFieldData;
  onChange: (key: string, value: string) => void;
  existingPayoutAccount?: PayoutRequirementAccount | null;
}) {
  const t = useTranslations();
  const providerCopy = provider === null ? undefined : REQUIREMENT_GROUP_COPY[provider];
  return (
    <div className="space-y-6">
      {requirementFieldRuns(fields).map((run) => {
        const first = run.fields[0];
        if (first.kind === "address") {
          return (
            <AddressRequirementField
              key={first.key}
              field={first}
              values={values}
              onChange={onChange}
            />
          );
        }
        const inputs = run.fields.map((field) => {
          const current = values[field.key];
          return (
            <RequirementFieldInput
              key={field.key}
              field={field}
              value={current === undefined ? "" : current}
              onChange={(value) => onChange(field.key, value)}
            />
          );
        });
        if (run.group === null || providerCopy === undefined) {
          return (
            <div key={first.key} className="space-y-6">
              {inputs}
            </div>
          );
        }
        const copy = requirementGroupCopy(providerCopy, run.group);
        return (
          <Card key={first.key}>
            <CardHeader>
              <CardTitle>{t(copy.title)}</CardTitle>
              <CardDescription>{t(copy.description)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">{inputs}</CardContent>
          </Card>
        );
      })}
      {existingPayoutAccount !== undefined && existingPayoutAccount !== null ? (
        <Card>
          <CardContent className="space-y-2">
            <p className="font-medium text-primary">
              {t("DashboardPayments.ramps.useExistingAccount")}
            </p>
            <p className="text-sm text-secondary">
              {t("DashboardPayments.ramps.useExistingAccountDescription")}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
