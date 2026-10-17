// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatNumber } from "@/lib/number-format";
import catalog from "../../../../messages/en/homepage.json";
import { createBenchController } from "./bench-controller";
import { buildFigure } from "./figures/build-figures";
import { createFigurePlayer } from "./figures/player";
import { FIGURE_WORDS, type FigureCopy } from "./figures/scene-input";
import { figureViewBox, PAYMENT_KINDS } from "./kinds";

const words = catalog.Homepage.payments.figure;
const copy: FigureCopy = {
  words: Object.fromEntries(FIGURE_WORDS.map((word) => [word, words[word]])) as FigureCopy["words"],
  paidTo: (address) => `to ${address}`,
  paidCount: (paid, total) => `${paid} of ${total} paid`,
  number: (value, fractionDigits) => formatNumber("en", value, fractionDigits),
  monthStart: (month) =>
    new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(
      Date.UTC(2000, month, 1)
    ),
};
const fonts = { sans: '"Season Sans", sans-serif', mono: "ui-monospace, monospace" };

describe("figureViewBox", () => {
  it("frames the whole floor on a wide screen and the drawing alone on a phone", () => {
    expect(figureViewBox("pay", false)).toBe("0 0 640 520");
    expect(figureViewBox("pay", true)).toBe("36 45 572 431");
  });
});

describe("buildFigure", () => {
  it.each(PAYMENT_KINDS)("draws %s as a labelled, timed svg in the catalog's words", (kind) => {
    const label = catalog.Homepage.payments.kinds[kind].figure;
    const svg = buildFigure(kind, { fonts, label, copy });
    expect(svg).not.toBeNull();
    const host = document.createElement("div");
    host.innerHTML = svg ?? "";
    const root = host.querySelector("svg");
    expect(root?.getAttribute("role")).toBe("img");
    expect(root?.getAttribute("aria-label")).toBe(label);
    expect(Number(root?.dataset.cycle)).toBeGreaterThan(0);
    expect(svg).not.toMatch(/NaN|undefined/);
    /* the resolved face is quoted safely inside the attribute */
    expect(host.querySelector("text")?.getAttribute("font-family")).toMatch(/monospace|sans-serif/);
  });

  it("sets the figure words from the catalog", () => {
    const svg = buildFigure("pay", { fonts, label: "Pay", copy }) ?? "";
    expect(svg).toContain(words.opsWallet);
    expect(svg).toContain(words.received);
    const batch = buildFigure("batch", { fonts, label: "Batch", copy }) ?? "";
    expect(batch).toContain("3 of 3 paid");
  });
});

describe("createFigurePlayer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays a cycle with .live, alternates the outcome and rests when eased", () => {
    const host = document.createElement("div");
    host.innerHTML = buildFigure("pay", { fonts, label: "Pay", copy }) ?? "";
    const svg = host.querySelector("svg") as SVGSVGElement;
    const onEnd = vi.fn();
    const player = createFigurePlayer(svg, "en", onEnd);
    expect(player.dwell).toBe(2 * 2000 + 900);
    player.start();
    expect(svg.classList.contains("live")).toBe(true);
    expect(svg.classList.contains("v1")).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(svg.classList.contains("live")).toBe(false);
    vi.advanceTimersByTime(900);
    expect(svg.classList.contains("v1")).toBe(true);
    player.ease();
    vi.advanceTimersByTime(2900);
    expect(player.busy).toBe(false);
    expect(svg.classList.contains("live")).toBe(false);
  });

  it("steps a counter on its beats and stops at once", () => {
    const host = document.createElement("div");
    host.innerHTML = buildFigure("micro", { fonts, label: "Micro", copy }) ?? "";
    const svg = host.querySelector("svg") as SVGSVGElement;
    const balance = svg.querySelector('[data-n="4.2"]');
    const player = createFigurePlayer(svg, "en", () => {});
    player.start();
    vi.advanceTimersByTime(700);
    expect(balance?.textContent).toBe("4.198");
    player.stop();
    expect(svg.classList.contains("live")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a rolling counter where it is", () => {
    const host = document.createElement("div");
    host.innerHTML = buildFigure("deposit", { fonts, label: "Deposit", copy }) ?? "";
    const svg = host.querySelector("svg") as SVGSVGElement;
    const balance = svg.querySelector('[data-n="1250"]');
    const player = createFigurePlayer(svg, "en", () => {});
    player.start();
    vi.advanceTimersByTime(980 + 200); // the balance is rolling from 1,250.00 to 1,750.00
    const rolling = balance?.textContent;
    expect(rolling).not.toBe("1,250.00");
    expect(rolling).not.toBe("1,750.00");
    player.stop();
    vi.advanceTimersByTime(1000);
    expect(balance?.textContent).toBe(rolling);
  });
});

describe("createBenchController", () => {
  let observers: { callback: IntersectionObserverCallback; disconnect: () => void }[] = [];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: IntersectionObserverCallback;
        disconnect = vi.fn();
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          observers.push(this);
        }
        observe() {}
      }
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Element.prototype.animate = vi.fn(() => {
      const animation = {
        cancel: vi.fn(),
        pause: vi.fn(),
        play: vi.fn(),
        playState: "running",
        onfinish: null,
      };
      return animation as unknown as Animation;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(reducedMotion: boolean) {
    const stage = document.createElement("div");
    const deck = document.createElement("div");
    const list = document.createElement("div");
    list.scrollTo = vi.fn();
    const tabs = PAYMENT_KINDS.map(() => document.createElement("button"));
    const bars = PAYMENT_KINDS.map(() => document.createElement("i"));
    const onShow = vi.fn();
    const onPlayingChange = vi.fn();
    const controller = createBenchController({
      kinds: PAYMENT_KINDS,
      stage,
      deck,
      list,
      tabs: () => tabs,
      bars: () => bars,
      classes: { fig: "fig", on: "on", out: "out" },
      reducedMotion,
      locale: "en",
      onShow,
      onPlayingChange,
    });
    controller.load(PAYMENT_KINDS.map((kind) => buildFigure(kind, { fonts, label: kind, copy })));
    return { controller, deck, onShow, onPlayingChange, tabs };
  }

  it("puts the first kind on the stage when it arrives, then follows the keys", () => {
    const { controller, deck, onShow, tabs } = setup(false);
    controller.arrive();
    expect(onShow).toHaveBeenLastCalledWith(0);
    expect(deck.querySelectorAll(".fig")).toHaveLength(6);
    expect(deck.querySelector(".fig.on")?.getAttribute("data-kind")).toBe("pay");
    const focus = vi.spyOn(tabs[5], "focus");
    controller.keyDown(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(onShow).toHaveBeenLastCalledWith(5);
    expect(focus).toHaveBeenCalled();
    controller.keyDown(new KeyboardEvent("keydown", { key: "Home" }));
    expect(onShow).toHaveBeenLastCalledWith(0);
    controller.destroy();
    expect(deck.children).toHaveLength(0);
    for (const observer of observers) expect(observer.disconnect).toHaveBeenCalled();
  });

  it("pauses and resumes the walk; the arrow keys pin it", () => {
    const { controller, onPlayingChange } = setup(false);
    controller.arrive();
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);
    controller.togglePlay();
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
    controller.togglePlay();
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);
    controller.keyDown(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
    controller.destroy();
  });

  it("under reduced motion never walks, fills a rule or fades", () => {
    const { controller, onPlayingChange } = setup(true);
    controller.arrive();
    controller.select(2);
    controller.togglePlay();
    expect(onPlayingChange).not.toHaveBeenCalledWith(true);
    expect(Element.prototype.animate).not.toHaveBeenCalled();
    controller.destroy();
  });
});
