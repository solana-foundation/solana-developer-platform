// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNearScreen, watchActive } from "./use-scene-active";

let observers: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  readonly scrollMargin = "";
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit
  ) {
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function intersect(isIntersecting: boolean) {
  const rect = DOMRect.fromRect();
  act(() => {
    for (const observer of observers) {
      observer.callback(
        [
          {
            isIntersecting,
            boundingClientRect: rect,
            intersectionRect: rect,
            rootBounds: null,
            intersectionRatio: isIntersecting ? 1 : 0,
            target: document.body,
            time: 0,
          },
        ],
        observer
      );
    }
  });
}

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  cleanup();
  observers = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("watchActive", () => {
  it("is active only while on screen and the tab is visible, until stopped", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const onChange = vi.fn();
    const stop = watchActive(document.body, { threshold: 0.3 }, onChange);
    expect(observers[0]?.options).toEqual({ threshold: 0.3 });
    intersect(true);
    expect(onChange).toHaveBeenLastCalledWith(true);
    setVisibility("hidden");
    expect(onChange).toHaveBeenLastCalledWith(false);
    setVisibility("visible");
    expect(onChange).toHaveBeenLastCalledWith(true);
    intersect(false);
    expect(onChange).toHaveBeenLastCalledWith(false);

    stop();
    onChange.mockClear();
    setVisibility("hidden");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("counts the element as on screen without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const onChange = vi.fn();
    watchActive(document.body, {}, onChange)();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearScreen(ref);
  return <div ref={ref} data-near={near} />;
}

describe("useNearScreen", () => {
  it("latches once the element comes within 200px of the screen", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const { container } = render(<Probe />);
    const probe = container.querySelector("div");
    expect(observers[0]?.options).toEqual({ rootMargin: "200px 0px" });
    expect(probe?.dataset.near).toBe("false");
    intersect(true);
    expect(probe?.dataset.near).toBe("true");
    intersect(false);
    expect(probe?.dataset.near).toBe("true");
  });
});
