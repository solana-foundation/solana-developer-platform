import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "./date-format";

const MIDDAY_UTC = "2026-11-04T12:00:00.000Z";

describe("date-format", () => {
  it.each([null, undefined, "", "not-a-date"])("leaves %j to the caller's placeholder", (iso) => {
    expect(formatDate("en", iso)).toBeNull();
  });

  it("formats in the locale it is given, each locale and style apart", () => {
    expect(formatDate("en", MIDDAY_UTC)).toBe("Nov 4, 2026");
    expect(formatDate("fr", MIDDAY_UTC)).toBe("4 nov. 2026");
    expect(formatDateTime("en", MIDDAY_UTC)).toMatch(/^Nov 4, 2026, \d{1,2}:\d{2}\s[AP]M$/);
  });
});
