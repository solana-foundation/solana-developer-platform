"use client";

import { Popover } from "@base-ui/react/popover";
import { ChevronDownIcon, ClockIcon } from "lucide-react";
import { useState } from "react";
import { getDefaultClassNames } from "react-day-picker";
import { useThemeScopeAttributes } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  displayValue,
  formatDateValue,
  parseDateValue,
  pickerLocale,
  timeValue,
} from "@/components/ui/date-picker";
import { triggerSizeClassName } from "@/components/ui/select";
import { TimeField } from "@/components/ui/time-field";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const defaultClassNames = getDefaultClassNames();

/**
 * New schedule's "Starts on" field: a filled trigger with a clock, opening a calendar as wide as
 * the field, its days square tiles (today on a wash, past days greyed out), then the time
 * and Done, then Clear. The shared `DateTimePicker` keeps a compact calendar on refresh pages;
 * this one is the schedule's own, and fills the column on purpose.
 *
 * The value is `YYYY-MM-DDTHH:mm` in local time, or "" for "start after activation". Picking a
 * day keeps the time already chosen (midnight until one is); the time needs a day first.
 */
export function ScheduleStartPicker({
  id,
  value,
  onChange,
  disablePast = false,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Disables days before today, as a first run must be in the future. */
  disablePast?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const themeScopeAttributes = useThemeScopeAttributes();
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateValue(value);
  const currentYear = new Date().getFullYear();
  const label = displayValue(value, locale, true) ?? t("Shared.SharedComponents.chooseDateAndTime");

  function selectDate(date: Date | undefined) {
    onChange(date ? `${formatDateValue(date)}T${timeValue(value) || "00:00"}` : "");
  }

  return (
    <div data-slot="schedule-start-picker" className="w-full">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          id={id}
          type="button"
          className={cn(
            "group/start flex w-full cursor-pointer items-center gap-2 bg-surface-tile text-left text-sm outline-none",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            triggerSizeClassName("xl")
          )}
        >
          <ClockIcon aria-hidden="true" className="size-5 shrink-0 text-secondary" />
          <span className={cn("min-w-0 flex-1 truncate", value ? "text-primary" : "text-tertiary")}>
            {label}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-secondary transition-transform group-data-[popup-open]/start:rotate-180 motion-reduce:transition-none"
          />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            {...themeScopeAttributes}
            className="z-50"
            side="bottom"
            align="start"
            sideOffset={4}
          >
            <Popover.Popup
              data-schedule-start-popup=""
              className="w-[var(--anchor-width)] min-w-fit rounded-[var(--select-popup-radius)] border border-[var(--select-popup-border)] bg-[var(--select-popup-bg)] shadow-[var(--select-popup-shadow)] outline-none"
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
                className="w-full p-3"
                classNames={{
                  // The calendar's own root is w-fit; here it spans the popup, so each day is a
                  // seventh of the field.
                  root: cn("w-full", defaultClassNames.root),
                }}
              />
              <div className="flex items-end gap-2 border-t border-border-default p-2">
                <div className="min-w-0 flex-1">
                  <span className="mb-1.5 block text-meta text-secondary">
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
              <div className="border-t border-border-default p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
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
