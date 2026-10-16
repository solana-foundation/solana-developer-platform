// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClientNow } from "./use-client-now";

const NOW = Date.parse("2026-10-13T15:00:00Z");

function Probe() {
  const now = useClientNow(60_000);
  return <span>{now === null ? "none" : String(now)}</span>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useClientNow", () => {
  it("renders no time on the server, so hydration has nothing to disagree with", () => {
    expect(renderToString(<Probe />)).toContain("none");
  });

  it("reads the browser's clock after mount and keeps counting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { result } = renderHook(() => useClientNow(60_000));
    expect(result.current).toBe(NOW);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(NOW + 60_000);
  });
});
