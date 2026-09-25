// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DateField } from "./date-field";

afterEach(cleanup);

function Harness({
  initial,
  onChange,
  minDate,
}: {
  initial: string;
  onChange: (value: string) => void;
  minDate?: Date;
}) {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <label htmlFor="send-on">Send on</label>
      <DateField
        id="send-on"
        label="Send on"
        value={value}
        minDate={minDate}
        placeholder="Choose date"
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </I18nProvider>
  );
}

const field = () => screen.getByLabelText<HTMLInputElement>("Send on");

describe("DateField", () => {
  it("shows the day as text and reads a typed one when the field is left", () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-10-01" onChange={onChange} />);
    expect(field().value).toBe("Oct 1, 2026");

    fireEvent.change(field(), { target: { value: "Nov 5, 2026" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(field());

    expect(onChange).toHaveBeenCalledWith("2026-11-05");
    expect(field().value).toBe("Nov 5, 2026");
  });

  it("reads an ISO day as a local one and commits on Enter", () => {
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "2026-12-24" } });
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("2026-12-24");
    expect(field().value).toBe("Dec 24, 2026");
  });

  it("puts back the last day for text that is not a date, and clears when emptied", () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-10-01" onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "next someday" } });
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
    expect(field().value).toBe("Oct 1, 2026");

    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(onChange).toHaveBeenCalledWith("");
    expect(field().placeholder).toBe("Choose date");
  });

  it("picks a day from the calendar on the chosen day's month, and closes", () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-10-01" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the calendar for Send on" }));

    expect(screen.getByText("October 2026")).toBeTruthy();
    const day = document.querySelector<HTMLButtonElement>(
      '[role="gridcell"][data-day="2026-10-15"] button'
    );
    fireEvent.click(day as HTMLButtonElement);

    expect(onChange).toHaveBeenCalledWith("2026-10-15");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(field().value).toBe("Oct 15, 2026");
  });

  it("keeps days before the first allowed one from being picked", () => {
    render(<Harness initial="" onChange={vi.fn()} minDate={new Date(2026, 9, 10)} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the calendar for Send on" }));

    expect(screen.getByText("October 2026")).toBeTruthy();
    const before = document.querySelector('[role="gridcell"][data-day="2026-10-09"] button');
    const first = document.querySelector('[role="gridcell"][data-day="2026-10-10"] button');
    expect(before?.hasAttribute("disabled")).toBe(true);
    expect(first?.hasAttribute("disabled")).toBe(false);
  });
});
