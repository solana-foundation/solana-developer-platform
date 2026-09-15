// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type UrlTableQueryAdapter, useUrlTableFilters } from "./use-url-table-filters";

const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

interface TestFilters {
  status: "all" | "open" | "closed";
  query: string;
}

const QUERY: UrlTableQueryAdapter<TestFilters> = {
  read: (state) => state.query,
  write: (state, query) => ({ ...state, query }),
  minLength: 2,
  maxLength: 20,
};

function href(state: TestFilters): string {
  const params = new URLSearchParams();
  if (state.status !== "all") params.set("status", state.status);
  if (state.query !== "") params.set("q", state.query);
  const query = params.toString();
  return `/trades${query === "" ? "" : `?${query}`}`;
}

afterEach(() => {
  vi.useRealTimers();
  replaceMock.mockClear();
  window.history.replaceState(null, "", "/");
});

describe("useUrlTableFilters", () => {
  it("flushes the live query and an immediate filter through one URL write", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useUrlTableFilters({
        returnedState: { status: "all", query: "" },
        href,
        query: QUERY,
      })
    );

    act(() => {
      result.current.setQueryInput(" ab ");
      result.current.updateFilters({ status: "open" });
    });

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenLastCalledWith("/trades?status=open&q=ab", { scroll: false });
    expect(result.current.state).toEqual({ status: "open", query: "ab" });

    act(() => vi.advanceTimersByTime(400));
    expect(replaceMock).toHaveBeenCalledTimes(1);
  });

  it("builds a later debounced query update from the latest filter state", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useUrlTableFilters({
        returnedState: { status: "all", query: "" },
        href,
        query: QUERY,
      })
    );

    act(() => {
      result.current.updateFilters({ status: "closed" });
      result.current.setQueryInput("needle");
    });
    act(() => vi.advanceTimersByTime(400));

    expect(replaceMock).toHaveBeenLastCalledWith("/trades?status=closed&q=needle", {
      scroll: false,
    });
  });

  it("keeps newer typing through an old server echo and adopts browser history", () => {
    vi.useFakeTimers();
    const view = renderHook(
      ({ returnedState }: { returnedState: TestFilters }) =>
        useUrlTableFilters({ returnedState, href, query: QUERY }),
      { initialProps: { returnedState: { status: "all", query: "" } as TestFilters } }
    );

    act(() => {
      view.result.current.setQueryInput("ab");
      vi.advanceTimersByTime(400);
    });
    act(() => view.result.current.setQueryInput("abc"));

    view.rerender({ returnedState: { status: "all", query: "ab" } });
    expect(view.result.current.queryInput).toBe("abc");

    act(() => {
      window.history.pushState(null, "", "/trades?q=history");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    view.rerender({ returnedState: { status: "all", query: "history" } });

    expect(view.result.current.queryInput).toBe("history");
    act(() => vi.advanceTimersByTime(400));
    expect(replaceMock).not.toHaveBeenCalledWith("/trades?q=abc", { scroll: false });
  });
});
