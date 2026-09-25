"use client";

import { Popover } from "@base-ui/react/popover";
import { format, isValid, type Locale, parse } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { getDefaultClassNames } from "react-day-picker";
import { useThemeScopeAttributes } from "@/components/theme-scope";
import { Calendar } from "@/components/ui/calendar";
import { formatDateValue, parseDateValue, pickerLocale } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/** "Oct 1, 2026" in English, "1 oct. 2026" in French: shown in the field and read back from it. */
const DISPLAY_FORMAT = "PP";

const defaultClassNames = getDefaultClassNames();

// The design's calendar: 28px days on the control corner, 14px weekday and day labels in the
// secondary ink (days of the next and previous month included), today on the faint wash, the
// month name centred between the arrows with nothing above or below it.
const CALENDAR_CLASSNAMES = {
  nav: cn(
    "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
    defaultClassNames.nav
  ),
  month_caption: cn(
    "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
    defaultClassNames.month_caption
  ),
  caption_label: cn(
    "text-sm font-medium text-primary select-none",
    defaultClassNames.caption_label
  ),
  weekday: cn(
    "flex-1 rounded-(--cell-radius) text-sm font-normal text-secondary select-none",
    defaultClassNames.weekday
  ),
  outside: cn("text-secondary", defaultClassNames.outside),
  today: cn(
    "rounded-(--cell-radius) bg-fill-subtle data-[selected=true]:rounded-none",
    defaultClassNames.today
  ),
};

/**
 * Reads a typed date: the field's own format first, then `YYYY-MM-DD`, then whatever the
 * browser's date parser accepts ("October 1 2026", "10/1/2026"), always as a local day.
 */
function parseTypedDate(text: string, locale: Locale): Date | null {
  const trimmed = text.trim();
  const iso = parseDateValue(trimmed);
  if (iso) return iso;
  const own = parse(trimmed, DISPLAY_FORMAT, new Date(), { locale });
  if (isValid(own)) return own;
  // `new Date("2026-10-01")` is midnight UTC, a day early west of Greenwich; such text that
  // failed the strict read above is not a date.
  if (/^\d{4}-/.test(trimmed)) return null;
  const loose = new Date(trimmed);
  return Number.isNaN(loose.getTime())
    ? null
    : new Date(loose.getFullYear(), loose.getMonth(), loose.getDate());
}

interface DateFieldProps {
  id?: string;
  /** The day as `YYYY-MM-DD`, or "" for none. */
  value: string;
  onChange: (value: string) => void;
  /** The field's name, which the calendar button's accessible name carries. */
  label: string;
  /** The first day that can be picked; earlier days show but cannot be chosen. */
  minDate?: Date;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * A date as its own field: the day typed or read as text ("Oct 1, 2026"), with a calendar
 * button at the field's end that opens a month under it. Typing is read when the field is left
 * or Enter is pressed; text that is not a date goes back to the last one, and an empty field
 * clears it.
 */
export function DateField({
  id,
  value,
  onChange,
  label,
  minDate,
  placeholder,
  disabled,
}: DateFieldProps) {
  const t = useTranslations();
  const locale = pickerLocale(useLocale());
  const themeScopeAttributes = useThemeScopeAttributes();
  const [open, setOpen] = useState(false);
  // What is being typed; null while the field shows the chosen day.
  const [draft, setDraft] = useState<string | null>(null);
  const selected = parseDateValue(value);
  const text = draft ?? (selected ? format(selected, DISPLAY_FORMAT, { locale }) : "");

  function commitDraft() {
    if (draft === null) return;
    setDraft(null);
    if (!draft.trim()) {
      if (value) onChange("");
      return;
    }
    const typed = parseTypedDate(draft, locale);
    if (typed) onChange(formatDateValue(typed));
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Input
        id={id}
        size="xl"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        inputClassName="tabular-nums"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitDraft();
          }
        }}
        action={
          <Popover.Trigger
            type="button"
            disabled={disabled}
            aria-label={t("Shared.SharedComponents.openCalendarFor", { field: label })}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-[var(--corner-control)] text-secondary outline-none transition-colors",
              "hover:bg-fill-subtle hover:text-primary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]",
              "data-[popup-open]:bg-fill-subtle data-[popup-open]:text-primary disabled:pointer-events-none disabled:opacity-40"
            )}
          >
            <CalendarIcon aria-hidden="true" className="size-4" />
          </Popover.Trigger>
        }
      />
      <Popover.Portal>
        <Popover.Positioner
          {...themeScopeAttributes}
          className="z-50"
          side="bottom"
          align="end"
          sideOffset={4}
        >
          {/* Flat: a card-paper panel on the design's 1px ring (outside the box, so the panel
              keeps the calendar's 212px), without the shadow the design adds under it. */}
          <Popover.Popup className="rounded-[var(--corner-card)] bg-surface-sunken outline-none ring-1 ring-border-subtle">
            <Calendar
              mode="single"
              locale={locale}
              selected={selected}
              defaultMonth={selected ?? minDate}
              onSelect={(day) => {
                if (!day) return;
                setDraft(null);
                onChange(formatDateValue(day));
                setOpen(false);
              }}
              disabled={minDate ? { before: minDate } : undefined}
              className="p-2 [--cell-radius:var(--corner-control)] [--cell-size:28px]"
              classNames={CALENDAR_CLASSNAMES}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
