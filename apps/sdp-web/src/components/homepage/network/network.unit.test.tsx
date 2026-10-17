// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
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

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduced,
}));

vi.mock("@/i18n/provider", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    useLocale: () => "en",
    useTranslations: () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

let reduced = false;

beforeEach(() => {
  reduced = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("reduce") ? reduced : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
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
  function placeAt(top: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top,
      bottom: top + 40,
    } as DOMRect);
  }

  it("shows the final figure in the catalog's words and reads it once", () => {
    placeAt(100);
    render(<CountUp to={30} message="Homepage.network.stats.partners.value" />);
    const shown = screen.getAllByText("30+");
    expect(shown).toHaveLength(2);
    expect(shown[0].getAttribute("aria-hidden")).toBe("true");
    expect(shown[1].className).toBe("sr-only");
  });

  it("keeps a figure already on screen at its final value instead of counting", () => {
    placeAt(100);
    render(<CountUp to={200} message="Homepage.network.stats.currencies.value" />);
    expect(screen.getAllByText("200+")).toHaveLength(2);
  });

  it("keeps the final figure on a figure that starts off screen until it counts", () => {
    placeAt(5000);
    render(<CountUp to={200} message="Homepage.network.stats.currencies.value" />);
    const shown = screen.getAllByText("200+");
    expect(shown).toHaveLength(2);
    expect(shown.some((element) => element.getAttribute("aria-hidden") === "true")).toBe(true);
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
    render(<SpeedRace />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^The same payment/);
    expect(screen.getByText("Solana, via SDP")).toBeTruthy();
  });

  it("draws one still frame with settled rows under reduced motion", () => {
    reduced = true;
    const ctx = new Proxy(
      {},
      { get: () => vi.fn(), set: () => true }
    ) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    act(() => {
      render(<SpeedRace />);
    });
    expect(screen.getAllByText(/^slot 291,0\d\d,\d{3}$/)).toHaveLength(3);
    expect(screen.getByText("1,020,000.00 USDC")).toBeTruthy();
    expect(screen.getByText("96.40 USDC")).toBeTruthy();
    expect(raf).not.toHaveBeenCalled();
  });
});
