// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useActionIdempotencyKey } from "./use-action-idempotency-key";

describe("useActionIdempotencyKey", () => {
  it("keeps one key per input until it succeeds, and gives changed input its own", () => {
    const { result } = renderHook(() => useActionIdempotencyKey());
    const first = result.current.keyFor("label=a");

    expect(result.current.keyFor("label=a")).toBe(first);
    result.current.settled("label=a", false);
    expect(result.current.keyFor("label=a")).toBe(first);

    const edited = result.current.keyFor("label=b");
    expect(edited).not.toBe(first);

    result.current.settled("label=b", true);
    expect(result.current.keyFor("label=b")).not.toBe(edited);
  });
});
