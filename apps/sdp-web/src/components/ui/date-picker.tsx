"use client";

import { Popover } from "@base-ui/react/popover";
import { enUS, fr } from "date-fns/locale";
import { CalendarIcon, ChevronDownIcon, ClockIcon } from "lucide-react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Calendar } from "@/components/ui/calendar";
import { triggerSizeClassName } from "@/components/ui/select";
import { TimeField } from "@/components/ui/time-field";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type DatePickerSize = "lg" | "xl";

interface DatePickerProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Disables selection of days before today. */
  disablePast?: boolean;
  size?: DatePickerSize;
  className?: string;
}

interface DateRangePickerProps {
  id?: string;
  from?: string;
  to?: string;
  defaultFrom?: string;
  defaultTo?: string;
  fromName?: string;
  toName?: string;
  onChange?: (from: string, to: string) => void;
  /** Disables selection of days after today. */
  disableFuture?: boolean;
  ariaLabel?: string;
  size?: DatePickerSize;
}

interface PickerProps extends DatePickerProps {
  includeTime: boolean;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

const POPUP_CLASSNAME =
  "rounded-[var(--select-popup-radius)] border border-[var(--select-popup-border)] bg-[var(--select-popup-bg)] shadow-[var(--select-popup-shadow)] outline-none";

/**
 * Resolves the app locale to the date-fns locale used by the calendar.
 *
 * @param locale - The active locale code.
 * @returns The matching date-fns locale.
 */
function pickerLocale(locale: string) {
  return locale === "fr" ? fr : enUS;
}

/**
 * Parses a `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` value into a local Date.
 *
 * @param value - The stored field value.
 * @returns The local date, or undefined when the value is absent or invalid.
 */
function parseDateValue(value: string | undefined): Date | undefined {
  const match = value?.match(DATE_PATTERN) ?? value?.match(DATE_TIME_PATTERN);
  if (!match) return undefined;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return undefined;
  }
  return date;
}

/**
 * Formats a local Date as a `YYYY-MM-DD` value.
 *
 * @param date - The date to format.
 * @returns The date portion of the field value.
 */
function formatDateValue(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Extracts the `HH:mm` portion of a datetime value.
 *
 * @param value - The stored field value.
 * @returns The time portion, or an empty string when the value has none.
 */
function timeValue(value: string): string {
  const match = value.match(DATE_TIME_PATTERN);
  return match ? `${match[4]}:${match[5]}` : "";
}

/**
 * Formats a stored value for display in the trigger.
 *
 * @param value - The stored field value.
 * @param locale - The active locale code.
 * @param includeTime - Whether to include the time portion.
 * @returns The localized label, or null when the value is absent or invalid.
 */
function displayValue(value: string, locale: string, includeTime: boolean): string | null {
  const date = parseDateValue(value);
  if (!date) return null;

  if (includeTime) {
    const time = timeValue(value);
    if (time) {
      const [hours, minutes] = time.split(":").map(Number);
      date.setHours(hours, minutes);
    }
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    ...(includeTime ? { timeStyle: "short" } : {}),
  }).format(date);
}

/**
 * Formats a stored range for display in the trigger.
 *
 * @param from - The stored range start.
 * @param to - The stored range end.
 * @param locale - The active locale code.
 * @param endPlaceholder - The label shown while the end date is unset.
 * @returns The localized range label, or null when the start is absent or invalid.
 */
function displayRangeValue(
  from: string,
  to: string,
  locale: string,
  endPlaceholder: string
): string | null {
  const fromLabel = displayValue(from, locale, false);
  if (!fromLabel) return null;
  const toLabel = displayValue(to, locale, false);
  return `${fromLabel} – ${toLabel ?? endPlaceholder}`;
}

function PickerTrigger({
  id,
  ariaLabel,
  size,
  className,
  icon: Icon,
  hasValue,
  label,
}: {
  id?: string;
  ariaLabel?: string;
  size: DatePickerSize;
  className?: string;
  icon: typeof CalendarIcon;
  hasValue: boolean;
  label: string;
}) {
  return (
    <Popover.Trigger
      id={id}
      type="button"
      aria-label={ariaLabel}
      className={cn(
        "group/date-picker flex w-full cursor-pointer items-center gap-2 text-left outline-none",
        "bg-fill-subtle text-sm focus-visible:ring-2 focus-visible:ring-[var(--input-focus-ring)] data-[popup-open]:shadow-[0_0_0_2px_var(--input-focus-ring)]",
        triggerSizeClassName(size),
        className
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0 text-secondary" />
      <span className={cn("min-w-0 flex-1 truncate", hasValue ? "text-primary" : "text-tertiary")}>
        {label}
      </span>
      <ChevronDownIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-secondary transition-transform group-data-[popup-open]/date-picker:rotate-180"
      />
    </Popover.Trigger>
  );
}

function Picker({
  id,
  value,
  onChange,
  disablePast,
  size = "lg",
  className,
  includeTime,
}: PickerProps) {
  const locale = useLocale();
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateValue(value);
  const currentYear = new Date().getFullYear();

  function selectDate(date: Date | undefined) {
    if (!date) {
      onChange("");
      return;
    }

    const nextDate = formatDateValue(date);
    if (includeTime) {
      onChange(`${nextDate}T${timeValue(value) || "00:00"}`);
    } else {
      onChange(nextDate);
      setOpen(false);
    }
  }

  const label =
    displayValue(value, locale, includeTime) ??
    t(
      includeTime
        ? "Shared.SharedComponents.chooseDateAndTime"
        : "Shared.SharedComponents.chooseDate"
    );

  return (
    <div data-slot="date-picker-root" className="w-full">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <PickerTrigger
          id={id}
          size={size}
          className={className}
          icon={includeTime ? ClockIcon : CalendarIcon}
          hasValue={Boolean(value)}
          label={label}
        />
        <Popover.Portal>
          <Popover.Positioner className="z-50" side="bottom" align="start" sideOffset={4}>
            <Popover.Popup className={cn(POPUP_CLASSNAME, "w-[var(--anchor-width)] min-w-fit")}>
              <Calendar
                mode="single"
                locale={pickerLocale(locale)}
                selected={selectedDate}
                defaultMonth={selectedDate}
                onSelect={selectDate}
                captionLayout="dropdown"
                startMonth={disablePast ? new Date() : new Date(currentYear - 100, 0)}
                endMonth={new Date(currentYear + 10, 11)}
                disabled={disablePast ? { before: new Date() } : undefined}
                className="w-full"
              />
              {includeTime ? (
                <div className="flex items-end gap-2 border-t border-border-default p-2">
                  <div className="min-w-0 flex-1">
                    <span className="mb-1.5 block text-xs font-medium text-secondary">
                      {t("Shared.SharedComponents.time")}
                    </span>
                    <TimeField
                      value={timeValue(value)}
                      onChange={(nextTime) => {
                        if (selectedDate) onChange(`${formatDateValue(selectedDate)}T${nextTime}`);
                      }}
                      ariaLabel={t("Shared.SharedComponents.time")}
                      disabled={!selectedDate}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setOpen(false)}
                    disabled={!selectedDate}
                  >
                    {t("Shared.SharedComponents.done")}
                  </Button>
                </div>
              ) : null}
              <div className="border-t border-border-default p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={!value}
                  onClick={() => onChange("")}
                >
                  {t("Shared.SharedComponents.clear")}
                </Button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export function DatePicker(props: DatePickerProps) {
  return <Picker {...props} includeTime={false} />;
}

export function DateTimePicker(props: DatePickerProps) {
  return <Picker {...props} includeTime />;
}

export function DateRangePicker({
  id,
  from,
  to,
  defaultFrom = "",
  defaultTo = "",
  fromName,
  toName,
  onChange,
  disableFuture,
  ariaLabel,
  size = "lg",
}: DateRangePickerProps) {
  const locale = useLocale();
  const t = useTranslations();
  const [internalRange, setInternalRange] = useState({ from: defaultFrom, to: defaultTo });
  const [draftRange, setDraftRange] = useState({ from: defaultFrom, to: defaultTo });
  const [open, setOpen] = useState(false);
  const currentFrom = from ?? internalRange.from;
  const currentTo = to ?? internalRange.to;
  const draftFromDate = parseDateValue(draftRange.from);
  const draftToDate = parseDateValue(draftRange.to);
  const selectedRange: DateRange | undefined = draftFromDate
    ? { from: draftFromDate, to: draftToDate }
    : undefined;
  const hasValue = Boolean(currentFrom || currentTo);
  const draftHasValue = Boolean(draftRange.from || draftRange.to);
  const label =
    displayRangeValue(currentFrom, currentTo, locale, t("Shared.SharedComponents.chooseEndDate")) ??
    t("Shared.SharedComponents.chooseDateRange");

  function update(nextFrom: string, nextTo: string) {
    setInternalRange({ from: nextFrom, to: nextTo });
    onChange?.(nextFrom, nextTo);
  }

  function selectRange(nextRange: DateRange | undefined) {
    const nextFrom = nextRange?.from ? formatDateValue(nextRange.from) : "";
    const nextTo = nextRange?.to ? formatDateValue(nextRange.to) : "";
    setDraftRange({ from: nextFrom, to: nextTo });
    if (nextFrom && nextTo) {
      update(nextFrom, nextTo);
      setOpen(false);
    }
  }

  function changeOpen(nextOpen: boolean) {
    setDraftRange({ from: currentFrom, to: currentTo });
    setOpen(nextOpen);
  }

  return (
    <div data-slot="date-picker-root" className="w-full">
      <Popover.Root open={open} onOpenChange={changeOpen}>
        {fromName ? <input type="hidden" name={fromName} value={currentFrom} /> : null}
        {toName ? <input type="hidden" name={toName} value={currentTo} /> : null}
        <PickerTrigger
          id={id}
          ariaLabel={ariaLabel}
          size={size}
          icon={CalendarIcon}
          hasValue={hasValue}
          label={label}
        />
        <Popover.Portal>
          <Popover.Positioner className="z-50" side="bottom" align="start" sideOffset={4}>
            <Popover.Popup className={cn(POPUP_CLASSNAME, "w-[var(--anchor-width)] min-w-fit")}>
              <Calendar
                mode="range"
                locale={pickerLocale(locale)}
                selected={selectedRange}
                defaultMonth={draftFromDate}
                onSelect={selectRange}
                numberOfMonths={2}
                resetOnSelect
                showOutsideDays={false}
                disabled={disableFuture ? { after: new Date() } : undefined}
                endMonth={disableFuture ? new Date() : undefined}
                className="w-full"
              />
              <div data-slot="date-range-actions" className="border-t border-border-default p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={!draftHasValue}
                  onClick={() => {
                    setDraftRange({ from: "", to: "" });
                    update("", "");
                    setOpen(false);
                  }}
                >
                  {t("Shared.SharedComponents.clear")}
                </Button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export { displayRangeValue, displayValue, formatDateValue, parseDateValue };
