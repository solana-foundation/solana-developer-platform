// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { intersect, setVisibility, stubIntersectionObserver } from "@/test/visibility";
import { useNearScreen, watchActive } from "./use-scene-active";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("watchActive", () => {
  it("is active only while on screen and the tab is visible, until stopped", () => {
    const observers = stubIntersectionObserver();
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
    const observers = stubIntersectionObserver();
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
