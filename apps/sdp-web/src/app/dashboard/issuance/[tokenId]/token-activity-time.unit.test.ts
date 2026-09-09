import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatActivityTimestamp,
  formatDate,
  formatDateTime,
} from "./token-management-workspace.utils";

afterEach(() => vi.unstubAllEnvs());

describe("issuance activity timestamps", () => {
  it("interprets timezone-less SQL audit timestamps as UTC", () => {
    vi.stubEnv("TZ", "America/Toronto");
    for (const format of [formatDateTime, formatActivityTimestamp, formatDate]) {
      expect(format("2026-09-08 02:13:36", "en")).toBe(format("2026-09-08T02:13:36Z", "en"));
    }
  });

  it("preserves explicit offsets and handles missing or invalid timestamps", () => {
    expect(formatDateTime("2026-09-08T18:13:36-04:00", "en")).toBe(
      formatDateTime("2026-09-08T22:13:36Z", "en")
    );
    expect(formatDateTime(null, "en")).toBe("—");
    expect(formatDateTime("not a date", "en")).toBe("not a date");
  });
});
