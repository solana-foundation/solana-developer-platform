"use client";

import { Popover } from "@base-ui/react/popover";
import { CalendarIcon, ChevronDownIcon, ClockIcon } from "lucide-react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { useThemeScope, useThemeScopeAttributes } from "@/components/theme-scope";
import { Calendar } from "@/components/ui/calendar";
import {
  displayRangeValue,
  displayValue,
  formatDateValue,
  parseDateValue,
  pickerLocale,
  timeValue,
} from "@/components/ui/date-value";
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

// A refresh calendar keeps its own size (36px days on the scope's inner control corner, 12px
// inset) instead of stretching to the field, whose width can be a whole form column.
const REFRESH_CALENDAR_CLASSNAME =
  "refresh:w-fit refresh:p-3 refresh:[--cell-radius:var(--corner-control-inner)] refresh:[--cell-size:36px]";

const POPUP_CLASSNAME =
  "rounded-[var(--select-popup-radius)] border border-[var(--select-popup-border)] bg-[var(--select-popup-bg)] shadow-[var(--select-popup-shadow)] outline-none";

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
        // Refresh surfaces draw it as the other fields do: an underline control, no icon.
        "refresh:border-b refresh:border-border-default refresh:bg-transparent refresh:text-field refresh:transition-colors refresh:hover:border-border-strong refresh:focus-visible:border-primary refresh:focus-visible:ring-0 refresh:data-[popup-open]:border-primary refresh:data-[popup-open]:shadow-none",
        triggerSizeClassName(size),
        className
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0 text-secondary refresh:hidden" />
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

/**
 * The refresh popup's footer: the time on its own line when the field takes one, then Clear and
 * Done on one row (Done only matters once there is a time to confirm).
 */
function RefreshPickerFooter({
  includeTime,
  time,
  onTimeChange,
  hasDate,
  hasValue,
  onClear,
  onDone,
}: {
  includeTime: boolean;
  time: string;
  onTimeChange: (time: string) => void;
  hasDate: boolean;
  hasValue: boolean;
  onClear: () => void;
  onDone: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="border-t border-border-default">
      {includeTime ? (
        <div className="flex items-center justify-between gap-4 px-3 pt-3">
          <span className="text-meta text-secondary">{t("Shared.SharedComponents.time")}</span>
          <TimeField
            value={time}
            onChange={onTimeChange}
            ariaLabel={t("Shared.SharedComponents.time")}
            disabled={!hasDate}
            className="w-40"
          />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 p-3">
        <Button type="button" variant="ghost" size="sm" disabled={!hasValue} onClick={onClear}>
          {t("Shared.SharedComponents.clear")}
        </Button>
        {includeTime ? (
          <Button type="button" size="sm" onClick={onDone} disabled={!hasDate}>
            {t("Shared.SharedComponents.done")}
          </Button>
        ) : null}
      </div>
    </div>
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
  const themeScopeAttributes = useThemeScopeAttributes();
  const refresh = useThemeScope() === "refresh";
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
          <Popover.Positioner
            {...themeScopeAttributes}
            className="z-50"
            side="bottom"
            align="start"
            sideOffset={4}
          >
            <Popover.Popup
              className={cn(POPUP_CLASSNAME, "w-[var(--anchor-width)] min-w-fit refresh:w-fit")}
            >
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
                className={cn("w-full", REFRESH_CALENDAR_CLASSNAME)}
              />
              {refresh ? (
                <RefreshPickerFooter
                  includeTime={includeTime}
                  time={timeValue(value)}
                  onTimeChange={(nextTime) => {
                    if (selectedDate) onChange(`${formatDateValue(selectedDate)}T${nextTime}`);
                  }}
                  hasDate={Boolean(selectedDate)}
                  hasValue={Boolean(value)}
                  onClear={() => onChange("")}
                  onDone={() => setOpen(false)}
                />
              ) : null}
              {!refresh && includeTime ? (
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
              {refresh ? null : (
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
              )}
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
  const themeScopeAttributes = useThemeScopeAttributes();
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
          <Popover.Positioner
            {...themeScopeAttributes}
            className="z-50"
            side="bottom"
            align="start"
            sideOffset={4}
          >
            <Popover.Popup
              className={cn(POPUP_CLASSNAME, "w-[var(--anchor-width)] min-w-fit refresh:w-fit")}
            >
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
                className={cn("w-full", REFRESH_CALENDAR_CLASSNAME)}
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
