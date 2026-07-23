import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimeField } from "./time-field";

describe("TimeField", () => {
  it("renders two accessible listbox comboboxes, not a native time input", () => {
    const markup = renderToStaticMarkup(
      <TimeField value="" onChange={() => undefined} ariaLabel="Opens" placeholder="--" />
    );

    // Two SDP Select dropdowns with listbox semantics, labelled with the field
    // context + column so screen readers announce e.g. "Opens Hours".
    expect(markup).not.toContain('type="time"');
    expect((markup.match(/role="combobox"/g) ?? []).length).toBe(2);
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-label="Opens Hours"');
    expect(markup).toContain('aria-label="Opens Minutes"');
    expect(markup).toContain("--");
  });

  it("shows the hour and minute parts of the current value", () => {
    const markup = renderToStaticMarkup(<TimeField value="09:30" onChange={() => undefined} />);

    // Value is visible text on the comboboxes (announced alongside the label,
    // since a combobox exposes name and value separately) and in the hidden
    // form inputs.
    expect(markup).toContain(">09<");
    expect(markup).toContain(">30<");
    expect(markup).toContain('value="09"');
    expect(markup).toContain('value="30"');
  });
});
