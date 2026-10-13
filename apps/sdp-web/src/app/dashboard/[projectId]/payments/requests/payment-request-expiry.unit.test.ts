// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { expiresAtForAction, settleExpiresAt } from "./payment-request-expiry";

const HOUR_MS = 60 * 60 * 1_000;
const inAnHour = () => new Date(Date.now() + HOUR_MS);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
  sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("expiresAtForAction", () => {
  it("does not send a frozen expiry that has passed, and the next press freezes a fresh one", () => {
    const first = expiresAtForAction("one-hour", inAnHour);
    expect(first).toBe("2026-10-13T13:00:00.000Z");
    settleExpiresAt("one-hour", { ok: false, status: null });

    vi.setSystemTime(new Date("2026-10-13T14:00:00.000Z"));
    expect(expiresAtForAction("one-hour", inAnHour)).toBeUndefined();
    expect(expiresAtForAction("one-hour", inAnHour)).toBe("2026-10-13T15:00:00.000Z");
  });

  it("retires the expiry when the retry's refusal is a replay, on the same answer as the key", () => {
    const first = expiresAtForAction("seven-days", inAnHour);
    settleExpiresAt("seven-days", { ok: false, status: null });
    expect(expiresAtForAction("seven-days", inAnHour)).toBe(first);
    settleExpiresAt("seven-days", { ok: false, status: 400, replayed: true });

    vi.setSystemTime(new Date("2026-10-13T12:30:00.000Z"));
    expect(expiresAtForAction("seven-days", inAnHour)).toBe("2026-10-13T13:30:00.000Z");
  });
});
