// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import {
  resetIdempotencyKeyStoresForTests,
  setIdempotencyKeyScope,
} from "@/lib/idempotency-key-store";
import { setWindowPathname } from "@/test/window-location";
import { expiresAtForAction, settleExpiresAt } from "./payment-request-expiry";

const HOUR_MS = 60 * 60 * 1_000;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a sent expiry");
  return value;
}
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

/** The instant a send carries, or `undefined` when it is not sent. */
const instantOf = (input: string, resolve: () => Date | null) =>
  expiresAtForAction(input, resolve)?.expiresAt;

describe("expiresAtForAction", () => {
  it("does not send a frozen expiry that has passed, and the next press freezes a fresh one", () => {
    const first = required(expiresAtForAction("one-hour", inAnHour));
    expect(first.expiresAt).toBe("2026-10-13T13:00:00.000Z");
    settleExpiresAt("one-hour", first, { ok: false, status: null });

    vi.setSystemTime(new Date("2026-10-13T14:00:00.000Z"));
    expect(expiresAtForAction("one-hour", inAnHour)).toBeUndefined();
    expect(instantOf("one-hour", inAnHour)).toBe("2026-10-13T15:00:00.000Z");
  });

  it("settles the entry its send went out with after the dashboard switched organization", () => {
    setIdempotencyKeyScope("user_a:org_a");
    const sent = required(expiresAtForAction("switched", inAnHour));
    setIdempotencyKeyScope("user_a:org_b");
    settleExpiresAt("switched", sent, { ok: true, status: 201 });

    setIdempotencyKeyScope("user_a:org_a");
    vi.setSystemTime(new Date("2026-10-13T12:30:00.000Z"));
    // Retired in its own organization: the next press there is a new action.
    expect(instantOf("switched", inAnHour)).toBe("2026-10-13T13:30:00.000Z");
    setIdempotencyKeyScope("");
  });

  it("retires the expiry when the retry's refusal is a replay, on the same answer as the key", () => {
    const first = required(expiresAtForAction("seven-days", inAnHour));
    expect(first.expiresAt).toBe("2026-10-13T13:00:00.000Z");
    settleExpiresAt("seven-days", first, { ok: false, status: null });
    const retry = required(expiresAtForAction("seven-days", inAnHour));
    expect(retry.expiresAt).toBe(first.expiresAt);
    settleExpiresAt("seven-days", retry, { ok: false, status: 400, replayed: true });

    vi.setSystemTime(new Date("2026-10-13T12:30:00.000Z"));
    expect(instantOf("seven-days", inAnHour)).toBe("2026-10-13T13:30:00.000Z");
  });

  // Greptile (#2333): an unreadable 422 kept the request's key but dropped its
  // expiry, so the retry was a new body under a new key.
  it("keeps the expiry when the answer could not be read, as the key is kept", () => {
    const first = required(expiresAtForAction("unreadable", inAnHour));
    settleExpiresAt("unreadable", first, { ok: false, status: 422, unreadable: true });

    vi.setSystemTime(new Date("2026-10-13T12:30:00.000Z"));
    expect(instantOf("unreadable", inAnHour)).toBe(first.expiresAt);
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
      const first = required(expiresAtForAction("unreadable-success", inAnHour));
      const res = await dashboardFetch("/api/dashboard/payments/requests", {
        method: "POST",
        body: { amount: "1", expiresAt: first.expiresAt },
      });
      settleExpiresAt("unreadable-success", first, res);

      expect(instantOf("unreadable-success", inAnHour)).toBe(first.expiresAt);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
