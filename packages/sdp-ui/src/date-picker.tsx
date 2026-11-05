"use client";

import { Popover } from "@base-ui/react/popover";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "./button";
import { Calendar } from "./calendar";
import { cn } from "./cn";
import {
  displayRangeValue,
  displayValue,
  formatDateValue,
  parseDateValue,
  pickerLocale,
  timeValue,
} from "./date-value";
import { useUiLocale, useUiTranslations } from "./i18n";
import { triggerSizeClassName } from "./select";
import { TimeField } from "./time-field";

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

// The calendar keeps its own size (36px days on the inner control corner, 12px inset) instead of
// stretching to the field, whose width can be a whole form column.
const CALENDAR_CLASSNAME =
  "w-fit p-3 [--cell-radius:var(--corner-control-inner)] [--cell-size:36px]";

const POPUP_CLASSNAME =
  "rounded-[var(--select-popup-radius)] border border-[var(--select-popup-border)] bg-[var(--select-popup-bg)] shadow-[var(--select-popup-shadow)] outline-none";

function PickerTrigger({
  id,
  ariaLabel,
  size,
  className,
  hasValue,
  label,
}: {
  id?: string;
  ariaLabel?: string;
  size: DatePickerSize;
  className?: string;
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
        // An underline control, as the other fields are.
        "border-b border-border-default bg-transparent text-field transition-colors hover:border-border-strong focus-visible:border-primary focus-visible:ring-0 data-[popup-open]:border-primary data-[popup-open]:shadow-none",
        triggerSizeClassName(size),
        className
      )}
    >
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
 * The popup's footer: the time on its own line when the field takes one, then Clear and Done on
 * one row (Done only matters once there is a time to confirm).
 */
function PickerFooter({
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
  const t = useUiTranslations();
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
  const locale = useUiLocale();
  const t = useUiTranslations();
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
          hasValue={Boolean(value)}
          label={label}
        />
        <Popover.Portal>
          <Popover.Positioner className="z-50" side="bottom" align="start" sideOffset={4}>
            <Popover.Popup className={cn(POPUP_CLASSNAME, "w-fit min-w-fit")}>
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
                className={CALENDAR_CLASSNAME}
              />
              <PickerFooter
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
  const locale = useUiLocale();
  const t = useUiTranslations();
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
          hasValue={hasValue}
          label={label}
        />
        <Popover.Portal>
          <Popover.Positioner className="z-50" side="bottom" align="start" sideOffset={4}>
            <Popover.Popup className={cn(POPUP_CLASSNAME, "w-fit min-w-fit")}>
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
                className={CALENDAR_CLASSNAME}
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
