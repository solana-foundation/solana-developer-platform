// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeIntersectionObserver,
  intersect,
  stubIntersectionObserver,
} from "@/test/visibility";
import { Rise, useRiseArrived } from "./rise";

let observers: readonly FakeIntersectionObserver[] = [];

/* the block reports, its top `top` px down an 800px screen */
function report({ isIntersecting, top }: { isIntersecting: boolean; top: number }) {
  const box = DOMRect.fromRect({ y: top, width: 100, height: 100 });
  intersect(isIntersecting, {
    boundingClientRect: box,
    intersectionRect: box,
    rootBounds: DOMRect.fromRect({ width: 1440, height: 800 }),
  });
}

function Probe() {
  return <span data-testid="probe">{String(useRiseArrived())}</span>;
}

beforeEach(() => {
  observers = stubIntersectionObserver();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Rise", () => {
  it("arrives when it reaches the screen and stops observing", () => {
    render(
      <Rise data-testid="block">
        <Probe />
      </Rise>
    );
    expect(screen.getByTestId("block").dataset.arrived).toBe("false");
    /* the noscript style finds the block by this */
    expect(screen.getByTestId("block").hasAttribute("data-rise")).toBe(true);
    expect(screen.getByTestId("probe").textContent).toBe("false");

    report({ isIntersecting: true, top: 400 });

    expect(screen.getByTestId("block").dataset.arrived).toBe("true");
    expect(screen.getByTestId("probe").textContent).toBe("true");
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  it("arrives when the page opened below it", () => {
    render(<Rise data-testid="block" />);

    report({ isIntersecting: false, top: -1200 });

    expect(screen.getByTestId("block").dataset.arrived).toBe("true");
  });

  it("waits while it is still below the screen", () => {
    render(<Rise data-testid="block" />);

    report({ isIntersecting: false, top: 1600 });

    expect(screen.getByTestId("block").dataset.arrived).toBe("false");
  });

  it("is outside any block for components rendered without one", () => {
    render(<Probe />);

    expect(screen.getByTestId("probe").textContent).toBe("null");
  });
});
