// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOpenRow } from "./use-open-row";

describe("useOpenRow", () => {
  it("opens a row, closes it again, and keeps one row open at a time", () => {
    const { result } = renderHook(() => useOpenRow());
    expect(result.current.isOpen("a")).toBe(false);

    act(() => result.current.toggle("a"));
    expect(result.current.isOpen("a")).toBe(true);

    act(() => result.current.toggle("b"));
    expect(result.current.isOpen("a")).toBe(false);
    expect(result.current.isOpen("b")).toBe(true);

    act(() => result.current.toggle("b"));
    expect(result.current.isOpen("b")).toBe(false);
  });
});
