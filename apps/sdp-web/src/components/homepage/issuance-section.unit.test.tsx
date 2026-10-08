// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("@/i18n/server", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    getRequestLocale: async () => "en",
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});
vi.mock("@/i18n/provider", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    useLocale: () => "en",
    useTranslations: () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
}));

import { easeOutCubic } from "@/lib/easing";
import { IssuanceSection } from "./issuance-section";
import { IssuanceSheet } from "./issuance-sheet";

let observerCallback: IntersectionObserverCallback | undefined;
const disconnect = vi.fn();

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect = disconnect;
  takeRecords() {
    return [];
  }
}

function showSheet() {
  act(() => {
    observerCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  });
}

beforeEach(() => {
  motion.reduced = false;
  observerCallback = undefined;
  disconnect.mockClear();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("IssuanceSection", () => {
  it("renders the section landmark with its heading, copy and sandbox link", async () => {
    const markup = renderToStaticMarkup(await IssuanceSection());
    const doc = new DOMParser().parseFromString(markup, "text/html");

    const section = doc.querySelector("section#issuance");
    expect(section?.getAttribute("data-ground")).toBe("paper");

    const heading = doc.querySelector("h2");
    expect(heading?.querySelector(".sr-only")?.textContent).toBe(
      "Issue the asset. Control after launch."
    );
    expect(doc.body.textContent).toContain("every operation auditable.");

    const link = doc.querySelector("a");
    expect(link?.textContent).toBe("Open issuance in the sandbox");
    expect(link?.getAttribute("href")).toBe("/dashboard/issuance");
    expect(link?.hasAttribute("target")).toBe(false);
    expect(link?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    // The status loops forever, so it is not a live region.
    expect(markup).not.toContain("aria-live");
  });
});

describe("IssuanceSheet", () => {
  it("lists the example asset as terms and values", () => {
    render(<IssuanceSheet />);
    const terms = screen.getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual([
      "USDx an example asset",
      "Standard",
      "Supply",
      "Transfer controls",
      "Authority",
      "Privacy",
    ]);
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("100,000,000")).toBeTruthy();
    expect(screen.getByText("Blocklist")).toBeTruthy();
  });

  it("stays in its first state under reduced motion", () => {
    motion.reduced = true;
    vi.useFakeTimers();
    render(<IssuanceSheet />);

    expect(observerCallback).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("100,000,000")).toBeTruthy();
  });

  it("runs the lifecycle while on screen and stops on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = render(<IssuanceSheet />);
    showSheet();

    act(() => {
      vi.advanceTimersByTime(900 + 2800 + 1200);
    });
    expect(screen.getByText("Minted")).toBeTruthy();
    expect(screen.getByText("100,250,000")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2800 + 300);
    });
    expect(screen.getByText("Paused", { selector: "b span" })).toBeTruthy();

    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not advance while off screen", () => {
    vi.useFakeTimers();
    render(<IssuanceSheet />);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("Live")).toBeTruthy();
  });
});

describe("helpers", () => {
  it("eases out from 0 to 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });
});
