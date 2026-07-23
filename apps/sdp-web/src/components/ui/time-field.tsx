"use client";

import { cn } from "@/lib/utils";
import { Select, SelectItem } from "./select";

// Two-digit 00–23 / 00–59 option lists, built once at module load.
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

// Split a stored "HH:MM" value into its parts; empty strings when unset.
function splitTime(value: string): [string, string] {
  const [hour = "", minute = ""] = value.split(":");
  return [hour, minute];
}

interface TimeFieldProps {
  // 24-hour "HH:MM", or "" when nothing is chosen yet.
  value: string;
  onChange: (value: string) => void;
  // Field context (e.g. "Opens"); prefixed onto each select's accessible name.
  ariaLabel?: string;
  hourColumnLabel?: string;
  minuteColumnLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

// A time input built from two SDP Select dropdowns (hours + minutes) rather than
// a native <input type="time">. The native picker popup can't be themed (its
// selection highlight is the browser's blue OS accent, which accent-color does
// not reach), whereas the base-ui Select popup follows the SDP palette and keeps
// the listbox a11y (keyboard nav, typeahead, focus management, value announced).
export function TimeField({
  value,
  onChange,
  ariaLabel,
  hourColumnLabel = "Hours",
  minuteColumnLabel = "Minutes",
  placeholder = "--",
  disabled,
  className,
}: TimeFieldProps) {
  const [hour, minute] = splitTime(value);
  const label = (part: string) => (ariaLabel ? `${ariaLabel} ${part}` : part);

  // Setting one column fills the other with "00" the first time, so the emitted
  // value is always a complete "HH:MM".
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Select
        ariaLabel={label(hourColumnLabel)}
        value={hour || null}
        onValueChange={(next) => onChange(`${next ?? "00"}:${minute || "00"}`)}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1"
      >
        {HOURS.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </Select>
      <span aria-hidden="true" className="text-sm text-tertiary">
        :
      </span>
      <Select
        ariaLabel={label(minuteColumnLabel)}
        value={minute || null}
        onValueChange={(next) => onChange(`${hour || "00"}:${next ?? "00"}`)}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1"
      >
        {MINUTES.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}
