import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDate, formatDateTime } from "./date-format";

const MIDDAY_UTC = "2026-11-04T12:00:00.000Z";
const LATE_EVENING_UTC = "2026-11-05T03:00:00.000Z";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("date-format", () => {
  it.each([null, undefined, "", "not-a-date"])("leaves %j to the caller's placeholder", (iso) => {
    expect(formatDate("en", "UTC", iso)).toBeNull();
  });

  it("formats in the locale it is given, each locale and style apart", () => {
    expect(formatDate("en", "UTC", MIDDAY_UTC)).toBe("Nov 4, 2026");
    expect(formatDate("fr", "UTC", MIDDAY_UTC)).toBe("4 nov. 2026");
    expect(formatDateTime("en", "UTC", MIDDAY_UTC)).toMatch(/^Nov 4, 2026, 12:00\sPM$/);
  });

  it("formats in the zone it is given, not the environment's", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(formatDate("en", "America/Chicago", LATE_EVENING_UTC)).toBe("Nov 4, 2026");
    expect(formatDate("en", "UTC", LATE_EVENING_UTC)).toBe("Nov 5, 2026");
    expect(formatDateTime("en", "America/Chicago", MIDDAY_UTC)).toMatch(/^Nov 4, 2026, 6:00\sAM$/);
  });
});
