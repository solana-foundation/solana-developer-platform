// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateValue } from "@/components/ui/date-picker";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ScheduleStartPicker } from "./schedule-start-picker";

afterEach(cleanup);

function Harness({ initial = "", onChange }: { initial?: string; onChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ScheduleStartPicker
      id="starts-on"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      disablePast
    />
  );
}

function renderPicker(initial?: string) {
  const onChange = vi.fn();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <Harness initial={initial} onChange={onChange} />
    </I18nProvider>
  );
  return onChange;
}

const trigger = () => document.getElementById("starts-on") as HTMLButtonElement;
const enabledDays = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-day]:not([disabled])"));
const dayValue = (day: HTMLButtonElement) =>
  day.closest('[role="gridcell"]')?.getAttribute("data-day");

describe("ScheduleStartPicker", () => {
  it("asks for a date and time, then opens the calendar with the time and Clear below it", () => {
    renderPicker();
    expect(trigger().textContent).toContain("Choose date and time");

    fireEvent.click(trigger());
    expect(document.querySelector("[data-schedule-start-popup]")).not.toBeNull();
    expect(screen.getByText("Time")).toBeTruthy();
    // Nothing to confirm or clear, and no time without a day.
    expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("greys out the days before today", () => {
    renderPicker();
    fireEvent.click(trigger());
    const today = formatDateValue(new Date());
    const past = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button[data-day][disabled]")
    ).map(dayValue);
    expect(past.every((value) => (value ?? "") < today)).toBe(true);
    expect(enabledDays().every((day) => (dayValue(day) ?? "") >= today)).toBe(true);
  });

  it("picks a day at midnight, stays open for the time, and closes on Done", () => {
    const onChange = renderPicker();
    fireEvent.click(trigger());
    const day = enabledDays().at(-1) as HTMLButtonElement;
    fireEvent.click(day);

    expect(onChange).toHaveBeenLastCalledWith(`${dayValue(day)}T00:00`);
    expect(document.querySelector("[data-schedule-start-popup]")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(document.querySelector("[data-schedule-start-popup]")).toBeNull();
    expect(trigger().textContent).not.toContain("Choose date and time");
  });

  it("keeps the chosen time when the day changes, and Clear empties the field", () => {
    const next = new Date();
    next.setMonth(next.getMonth() + 1, 10);
    const onChange = renderPicker(`${formatDateValue(next)}T09:30`);
    fireEvent.click(trigger());
    const other = enabledDays().find((day) => dayValue(day) !== formatDateValue(next));
    fireEvent.click(other as HTMLButtonElement);
    expect(onChange).toHaveBeenLastCalledWith(`${dayValue(other as HTMLButtonElement)}T09:30`);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
