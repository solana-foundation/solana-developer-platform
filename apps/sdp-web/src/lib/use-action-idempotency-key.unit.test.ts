// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { resetIdempotencyKeyStoresForTests } from "./idempotency-key-store";
import { useActionIdempotencyKey } from "./use-action-idempotency-key";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  resetDashboardNavigation();
});

/** What a reload leaves: `sessionStorage`, and no module memory. */
function reload(): void {
  resetIdempotencyKeyStoresForTests();
}

describe("useActionIdempotencyKey", () => {
  it("keeps one key per input until it succeeds, and gives changed input its own", () => {
    const { result } = renderHook(() => useActionIdempotencyKey(null));
    const first = result.current.keyFor("label=a");

    expect(result.current.keyFor("label=a")).toBe(first);
    result.current.settled("label=a", first, {
      status: "error",
      answer: { status: 503, replayed: false, code: null },
    });
    expect(result.current.keyFor("label=a")).toBe(first);

    const edited = result.current.keyFor("label=b");
    expect(edited).not.toBe(first);

    result.current.settled("label=b", edited, { status: "success" });
    expect(result.current.keyFor("label=b")).not.toBe(edited);
  });

  it("reuses A's unanswered key after the user went A, B and back to A", () => {
    const { result } = renderHook(() => useActionIdempotencyKey(null));
    const a = result.current.keyFor("label=a");
    result.current.settled("label=a", a, {
      status: "error",
      answer: { status: 503, replayed: false, code: null },
    });

    const b = result.current.keyFor("label=b");
    result.current.settled("label=b", b, {
      status: "error",
      answer: { status: 503, replayed: false, code: null },
    });

    expect(result.current.keyFor("label=a")).toBe(a);
    expect(result.current.keyFor("label=b")).toBe(b);
  });

  // A server action hides Idempotent-Replayed from the browser, so the action
  // reports it: a stored failure replayed is definitive and must not replay forever.
  it("retires the key on a replayed failure and on a 422, and keeps it on a plain refusal", () => {
    const { result } = renderHook(() => useActionIdempotencyKey(null));
    const replayed = result.current.keyFor("label=a");
    result.current.settled("label=a", replayed, {
      status: "error",
      answer: { status: 503, replayed: false, code: null },
    });
    result.current.settled("label=a", replayed, {
      status: "error",
      answer: { status: 400, replayed: true, code: null },
    });
    expect(result.current.keyFor("label=a")).not.toBe(replayed);

    const reused = result.current.keyFor("label=b");
    result.current.settled("label=b", reused, {
      status: "error",
      answer: { status: 422, replayed: false, code: null },
    });
    expect(result.current.keyFor("label=b")).not.toBe(reused);

    // An unstored refusal runs again under the same key; nothing to retire.
    const refused = result.current.keyFor("label=c");
    result.current.settled("label=c", refused, {
      status: "error",
      answer: { status: 400, replayed: false, code: null },
    });
    expect(result.current.keyFor("label=c")).toBe(refused);
  });

  // The original never recorded its outcome: every retry under the key gets
  // the same 409, so the next press is a new action. One in flight runs again.
  it("retires the key on a 409 whose outcome is unknown, and keeps it on one in flight", () => {
    const { result } = renderHook(() => useActionIdempotencyKey(null));
    const key = result.current.keyFor("wallet=treasury");
    result.current.settled("wallet=treasury", key, {
      status: "error",
      answer: { status: 409, replayed: false, code: "IDEMPOTENCY_KEY_IN_FLIGHT" },
    });
    expect(result.current.keyFor("wallet=treasury")).toBe(key);
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();

    result.current.settled("wallet=treasury", key, {
      status: "error",
      answer: { status: 409, replayed: false, code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN" },
    });
    // The page refreshes, so a wallet the earlier attempt made shows up.
    expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1);
    expect(result.current.keyFor("wallet=treasury")).not.toBe(key);
  });

  it("keeps the key when a refusal follows an unanswered attempt, or the action threw", () => {
    const { result } = renderHook(() => useActionIdempotencyKey(null));
    const key = result.current.keyFor("label=a");
    result.current.settled("label=a", key, { status: "error" });
    result.current.settled("label=a", key, {
      status: "error",
      answer: { status: 400, replayed: false, code: null },
    });
    expect(result.current.keyFor("label=a")).toBe(key);
  });

  // Browser test (HOO-1918): a key only in a React ref died with the page, so
  // a reload after an unanswered wallet create sent a second wallet.
  it("keeps an unanswered key across a reload", () => {
    const { result } = renderHook(() => useActionIdempotencyKey(null));
    const key = result.current.keyFor("wallet=treasury");
    result.current.settled("wallet=treasury", key, {
      status: "error",
      answer: { status: 503, replayed: false, code: null },
    });

    reload();
    const { result: reloaded } = renderHook(() => useActionIdempotencyKey(null));

    expect(reloaded.current.keyFor("wallet=treasury")).toBe(key);
  });

  it("treats a send cut off by a reload as unanswered, so a refusal keeps its key", () => {
    const { result } = renderHook(() => useActionIdempotencyKey(null));
    const key = result.current.keyFor("wallet=treasury");

    reload();
    const { result: reloaded } = renderHook(() => useActionIdempotencyKey(null));
    expect(reloaded.current.keyFor("wallet=treasury")).toBe(key);
    reloaded.current.settled("wallet=treasury", key, {
      status: "error",
      answer: { status: 400, replayed: false, code: null },
    });

    expect(reloaded.current.keyFor("wallet=treasury")).toBe(key);
  });

  it("still keeps one key per input in this page when storage refuses writes", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    try {
      const { result } = renderHook(() => useActionIdempotencyKey(null));
      const key = result.current.keyFor("label=a");
      result.current.settled("label=a", key, {
        status: "error",
        answer: { status: 503, replayed: false, code: null },
      });

      expect(result.current.keyFor("label=a")).toBe(key);
    } finally {
      setItem.mockRestore();
    }
  });
});
