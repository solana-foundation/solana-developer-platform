import { describe, expect, it } from "vitest";
import { formatDateValue, parseDateValue } from "./date-value";

describe("date values", () => {
  it("round-trips valid local dates without a UTC offset", () => {
    const date = parseDateValue("2026-08-04");
    expect(date).toBeDefined();
    expect(formatDateValue(date as Date)).toBe("2026-08-04");
    expect(parseDateValue("2026-02-30")).toBeUndefined();
  });
});
