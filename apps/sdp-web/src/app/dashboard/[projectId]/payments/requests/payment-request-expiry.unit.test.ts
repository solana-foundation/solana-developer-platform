// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { setWindowPathname } from "@/test/window-location";
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
    settleExpiresAt("one-hour", "2026-10-13T13:00:00.000Z", { ok: false, status: null });

    vi.setSystemTime(new Date("2026-10-13T14:00:00.000Z"));
    expect(expiresAtForAction("one-hour", inAnHour)).toBeUndefined();
    expect(expiresAtForAction("one-hour", inAnHour)).toBe("2026-10-13T15:00:00.000Z");
  });

  it("retires the expiry when the retry's refusal is a replay, on the same answer as the key", () => {
    const first = "2026-10-13T13:00:00.000Z";
    expect(expiresAtForAction("seven-days", inAnHour)).toBe(first);
    settleExpiresAt("seven-days", first, { ok: false, status: null });
    expect(expiresAtForAction("seven-days", inAnHour)).toBe(first);
    settleExpiresAt("seven-days", first, { ok: false, status: 400, replayed: true });

    vi.setSystemTime(new Date("2026-10-13T12:30:00.000Z"));
    expect(expiresAtForAction("seven-days", inAnHour)).toBe("2026-10-13T13:30:00.000Z");
  });

  // Greptile (#2333): an unreadable 422 kept the request's key but dropped its
  // expiry, so the retry was a new body under a new key.
  it("keeps the expiry when the answer could not be read, as the key is kept", () => {
    const first = "2026-10-13T13:00:00.000Z";
    expect(expiresAtForAction("unreadable", inAnHour)).toBe(first);
    settleExpiresAt("unreadable", first, { ok: false, status: 422, unreadable: true });

    vi.setSystemTime(new Date("2026-10-13T12:30:00.000Z"));
    expect(expiresAtForAction("unreadable", inAnHour)).toBe(first);
  });

  // Greptile (#2333): a success whose body could not be read kept the key in
  // dashboard-fetch's store but dropped the expiry, so the retry was a new body.
  it("keeps the expiry when a success cannot be read, as the key is kept", async () => {
    vi.useRealTimers();
    setWindowPathname("/dashboard/prj_test_sandbox/payments/requests");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", { status: 200, headers: { "content-type": "application/json" } })
      )
    );
    try {
      const first = expiresAtForAction("unreadable-success", inAnHour);
      const res = await dashboardFetch("/api/dashboard/payments/requests", {
        method: "POST",
        body: { amount: "1", expiresAt: first },
      });
      settleExpiresAt("unreadable-success", first ?? null, res);

      expect(expiresAtForAction("unreadable-success", inAnHour)).toBe(first);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
