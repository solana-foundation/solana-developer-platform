// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useActionIdempotencyKey } from "./use-action-idempotency-key";

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
});
