// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DateRangePicker, displayRangeValue, formatDateValue, parseDateValue } from "./date-picker";

afterEach(cleanup);

describe("DateRangePicker", () => {
  it("renders one range trigger while preserving separate form values", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <DateRangePicker
          fromName="from"
          toName="to"
          defaultFrom="2026-01-05"
          defaultTo="2026-01-19"
          ariaLabel="Audit dates"
        />
      </I18nProvider>
    );

    expect(markup).toContain('aria-label="Audit dates"');
    expect(markup).toContain("Jan 5, 2026 – Jan 19, 2026");
    expect(markup).toContain('name="from" value="2026-01-05"');
    expect(markup).toContain('name="to" value="2026-01-19"');
    expect(markup).not.toContain('type="date"');
  });

  it("prompts for the end date when a range is incomplete", () => {
    expect(displayRangeValue("2026-01-05", "", "en", "Choose end date")).toBe(
      "Jan 5, 2026 – Choose end date"
    );
  });

  it("round-trips valid local dates without a UTC offset", () => {
    const date = parseDateValue("2026-08-04");
    expect(date).toBeDefined();
    expect(formatDateValue(date as Date)).toBe("2026-08-04");
    expect(parseDateValue("2026-02-30")).toBeUndefined();
  });

  it("keeps the popover open until the end date and commits only the complete range", () => {
    const onChange = vi.fn();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <DateRangePicker ariaLabel="Audit dates" onChange={onChange} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Audit dates" }));
    expect(document.querySelector('[data-slot="date-range-actions"]')).not.toBeNull();
    const firstDay = document.querySelector<HTMLButtonElement>("button[data-day]:not([disabled])");
    expect(firstDay).not.toBeNull();
    const firstValue = firstDay?.closest('[role="gridcell"]')?.getAttribute("data-day");
    fireEvent.click(firstDay as HTMLButtonElement);

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(document.querySelector('[data-slot="date-range-actions"]')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    const endDay = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button[data-day]:not([disabled])")
    ).find((day) => day.dataset.day !== firstDay?.dataset.day);
    expect(endDay).toBeDefined();
    const endValue = endDay?.closest('[role="gridcell"]')?.getAttribute("data-day");
    fireEvent.click(endDay as HTMLButtonElement);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(firstValue, endValue);
  });
});
