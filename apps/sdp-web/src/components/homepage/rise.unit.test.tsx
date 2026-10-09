// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rise, useRiseArrived } from "./rise";

let observer: FakeIntersectionObserver | undefined;
const disconnect = vi.fn();

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  readonly scrollMargin = "";
  constructor(readonly callback: IntersectionObserverCallback) {
    observer = this;
  }
  observe() {}
  unobserve() {}
  disconnect = disconnect;
  takeRecords() {
    return [];
  }
}

/* the block reports, its top `top` px down an 800px screen */
function report({ isIntersecting, top }: { isIntersecting: boolean; top: number }) {
  const current = observer;
  if (!current) throw new Error("no observer");
  const box = DOMRect.fromRect({ y: top, width: 100, height: 100 });
  act(() => {
    current.callback(
      [
        {
          isIntersecting,
          boundingClientRect: box,
          intersectionRect: box,
          rootBounds: DOMRect.fromRect({ width: 1440, height: 800 }),
          intersectionRatio: isIntersecting ? 1 : 0,
          target: document.body,
          time: 0,
        },
      ],
      current
    );
  });
}

function Probe() {
  return <span data-testid="probe">{String(useRiseArrived())}</span>;
}

beforeEach(() => {
  observer = undefined;
  disconnect.mockClear();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
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
    expect(disconnect).toHaveBeenCalled();
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
