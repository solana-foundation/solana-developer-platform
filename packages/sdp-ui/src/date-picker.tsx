"use client";

import { Popover } from "@base-ui/react/popover";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";
import { Calendar } from "./calendar";
import { cn } from "./cn";
import {
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
 * The popup's footer: the time on its own line, then Clear and Done on one row.
 */
function PickerFooter({
  time,
  onTimeChange,
  hasDate,
  hasValue,
  onClear,
  onDone,
}: {
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
      <div className="flex items-center justify-between gap-2 p-3">
        <Button type="button" variant="ghost" size="sm" disabled={!hasValue} onClick={onClear}>
          {t("Shared.SharedComponents.clear")}
        </Button>
        <Button type="button" size="sm" onClick={onDone} disabled={!hasDate}>
          {t("Shared.SharedComponents.done")}
        </Button>
      </div>
    </div>
  );
}

export function DateTimePicker({
  id,
  value,
  onChange,
  disablePast,
  size = "lg",
  className,
}: DatePickerProps) {
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

    onChange(`${formatDateValue(date)}T${timeValue(value) || "00:00"}`);
  }

  const label = displayValue(value, locale, true) ?? t("Shared.SharedComponents.chooseDateAndTime");

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
