// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rise } from "@/components/homepage/rise";
import { EnglishI18n } from "@/test/i18n";
import { setReducedMotion, stubMatchMedia } from "@/test/media-queries";
import { intersect, stubIntersectionObserver } from "@/test/visibility";
import { CountUp, countAt } from "./count-up";
import {
  createRaceState,
  LANE_SECONDS,
  laneFraction,
  launch,
  railEnd,
  stepAndDraw,
} from "./speed-canvas";
import { SpeedRace } from "./speed-race";

beforeEach(() => {
  stubMatchMedia();
  setReducedMotion(false);
  stubIntersectionObserver();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("countAt", () => {
  it("starts at zero, eases out and lands on the target", () => {
    expect(countAt(200, 0)).toBe(0);
    expect(countAt(200, 0.5)).toBe(175);
    expect(countAt(200, 1)).toBe(200);
    expect(countAt(200, 3)).toBe(200);
  });
});

describe("CountUp", () => {
  it("stands at zero until its block comes in, then counts up to the figure, read once", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "performance"],
    });
    render(
      <Rise index={2}>
        <CountUp to={30} message="Homepage.network.stats.partners.value" />
      </Rise>,
      { wrapper: EnglishI18n }
    );
    // the moving digits at zero, the final figure for assistive tech
    expect(screen.getByText("0+").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("30+").className).toBe("sr-only");

    intersect(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const shown = screen.getAllByText("30+");
    expect(shown).toHaveLength(2);
    expect(shown[0].getAttribute("aria-hidden")).toBe("true");
    vi.useRealTimers();
  });

  it("shows the final figure at once under reduced motion", () => {
    setReducedMotion(true);
    render(<CountUp to={200} message="Homepage.network.stats.currencies.value" />, {
      wrapper: EnglishI18n,
    });
    expect(screen.getAllByText("200+")).toHaveLength(2);
    expect(screen.queryByText("0+")).toBeNull();
  });
});

describe("speed canvas geometry", () => {
  it("places the four rails between 18% and 82% of the box", () => {
    expect(laneFraction(0)).toBeCloseTo(0.18);
    expect(laneFraction(3)).toBeCloseTo(0.82);
  });

  it("ends the rails with the second column, or near the edge without the list", () => {
    expect(railEnd(1240, true)).toBeCloseTo(818);
    expect(railEnd(350, false)).toBe(326);
  });
});

describe("stepAndDraw", () => {
  function fakeContext() {
    const gradient = { addColorStop: vi.fn() };
    // SAFETY: every member the drawing reads is a stub; gradients answer addColorStop.
    return new Proxy(
      {},
      {
        get: (_, name) =>
          name === "createLinearGradient" || name === "createRadialGradient"
            ? () => gradient
            : vi.fn(),
        set: () => true,
      }
    ) as CanvasRenderingContext2D;
  }

  it("settles the Solana payment in under a second while the others are still moving", () => {
    const ctx = fakeContext();
    const state = createRaceState();
    launch(state);
    let settled = 0;
    for (let i = 0; i < 20; i++) {
      settled += stepAndDraw(ctx, state, { width: 1000, height: 400, right: 650 }, 0.05);
    }
    expect(LANE_SECONDS[0]).toBeLessThan(1);
    expect(settled).toBe(1);
    expect(state.lanes[0]).toHaveLength(0);
    expect(state.lanes[1]).toHaveLength(1);
    expect(state.ripples).toHaveLength(1);
  });
});

describe("SpeedRace", () => {
  it("keeps its labels when the 2D context is unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<SpeedRace />, { wrapper: EnglishI18n });
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^The same payment/);
    expect(screen.getByText("Solana, via SDP")).toBeTruthy();
  });

  it("draws one still frame with settled rows under reduced motion", () => {
    setReducedMotion(true);
    // SAFETY: every member the still frame reads is a stub that returns undefined.
    const ctx = new Proxy({}, { get: () => vi.fn(), set: () => true }) as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    act(() => {
      render(<SpeedRace />, { wrapper: EnglishI18n });
    });
    expect(screen.getAllByText(/^slot 291,0\d\d,\d{3}$/)).toHaveLength(3);
    expect(screen.getByText("1,020,000.00 USDC")).toBeTruthy();
    expect(screen.getByText("96.40 USDC")).toBeTruthy();
    expect(raf).not.toHaveBeenCalled();
  });
});
