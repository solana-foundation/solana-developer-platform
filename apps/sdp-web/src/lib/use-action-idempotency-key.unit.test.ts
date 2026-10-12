// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetActionMemosForTests } from "./action-memo";
import { useActionIdempotencyKey } from "./use-action-idempotency-key";

beforeEach(() => {
  window.sessionStorage.clear();
  resetActionMemosForTests();
});

/** What a reload leaves: `sessionStorage`, and no module memory. */
function reload(): void {
  resetActionMemosForTests();
}

describe("useActionIdempotencyKey", () => {
  it("keeps one key per input until it succeeds, and gives changed input its own", () => {
    const { result } = renderHook(() => useActionIdempotencyKey());
    const first = result.current.keyFor("label=a");

    expect(result.current.keyFor("label=a")).toBe(first);
    result.current.settled("label=a", { status: "error", keyAnswer: "open" });
    expect(result.current.keyFor("label=a")).toBe(first);

    const edited = result.current.keyFor("label=b");
    expect(edited).not.toBe(first);

    result.current.settled("label=b", { status: "success" });
    expect(result.current.keyFor("label=b")).not.toBe(edited);
  });

  it("reuses A's unanswered key after the user went A, B and back to A", () => {
    const { result } = renderHook(() => useActionIdempotencyKey());
    const a = result.current.keyFor("label=a");
    result.current.settled("label=a", { status: "error", keyAnswer: "open" });

    const b = result.current.keyFor("label=b");
    result.current.settled("label=b", { status: "error", keyAnswer: "open" });

    expect(result.current.keyFor("label=a")).toBe(a);
    expect(result.current.keyFor("label=b")).toBe(b);
  });

  // A server action hides Idempotent-Replayed from the browser, so the action
  // reports it: a stored failure replayed is definitive and must not replay forever.
  it("retires the key on a replayed failure and on a refusal of a fresh key", () => {
    const { result } = renderHook(() => useActionIdempotencyKey());
    const replayed = result.current.keyFor("label=a");
    result.current.settled("label=a", { status: "error", keyAnswer: "open" });
    result.current.settled("label=a", { status: "error", keyAnswer: "definitive" });
    expect(result.current.keyFor("label=a")).not.toBe(replayed);

    const refused = result.current.keyFor("label=b");
    result.current.settled("label=b", { status: "error", keyAnswer: "refused" });
    expect(result.current.keyFor("label=b")).not.toBe(refused);
  });

  it("keeps the key when a refusal follows an unanswered attempt, or the action threw", () => {
    const { result } = renderHook(() => useActionIdempotencyKey());
    const key = result.current.keyFor("label=a");
    result.current.settled("label=a", { status: "error" });
    result.current.settled("label=a", { status: "error", keyAnswer: "refused" });
    expect(result.current.keyFor("label=a")).toBe(key);
  });

  // Browser test (HOO-1918): a key only in a React ref died with the page, so
  // a reload after an unanswered wallet create sent a second wallet.
  it("keeps an unanswered key across a reload", () => {
    const { result } = renderHook(() => useActionIdempotencyKey());
    const key = result.current.keyFor("wallet=treasury");
    result.current.settled("wallet=treasury", { status: "error", keyAnswer: "open" });

    reload();
    const { result: reloaded } = renderHook(() => useActionIdempotencyKey());

    expect(reloaded.current.keyFor("wallet=treasury")).toBe(key);
  });

  it("treats a send cut off by a reload as unanswered, so a refusal keeps its key", () => {
    const { result } = renderHook(() => useActionIdempotencyKey());
    const key = result.current.keyFor("wallet=treasury");

    reload();
    const { result: reloaded } = renderHook(() => useActionIdempotencyKey());
    expect(reloaded.current.keyFor("wallet=treasury")).toBe(key);
    reloaded.current.settled("wallet=treasury", { status: "error", keyAnswer: "refused" });

    expect(reloaded.current.keyFor("wallet=treasury")).toBe(key);
  });

  it("still keeps one key per input in this page when storage refuses writes", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    try {
      const { result } = renderHook(() => useActionIdempotencyKey());
      const key = result.current.keyFor("label=a");
      result.current.settled("label=a", { status: "error", keyAnswer: "open" });

      expect(result.current.keyFor("label=a")).toBe(key);
    } finally {
      setItem.mockRestore();
    }
  });
});
