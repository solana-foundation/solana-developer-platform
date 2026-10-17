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

import { PrivacyBubble } from "./privacy/privacy-bubble";
import { PrivacySection } from "./privacy-section";

const words = ["Payments", "Issuance", "Markets", "Payroll", "Balances"];
const label = "What stays private: payments, issuance, markets, payroll, balances";

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

function showBubble() {
  act(() => {
    observerCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  });
}

function currentWord(bubble: HTMLElement) {
  return bubble.querySelector("[data-current]")?.textContent;
}

beforeEach(() => {
  // jsdom has no font loading
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  motion.reduced = false;
  observerCallback = undefined;
  disconnect.mockClear();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  // a narrow screen: the cycle starts without the wide-screen stagger
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PrivacySection", () => {
  it("renders the section landmark with its heading, copy and link", async () => {
    const markup = renderToStaticMarkup(await PrivacySection());
    const doc = new DOMParser().parseFromString(markup, "text/html");

    const section = doc.querySelector("section#privacy");
    expect(section?.getAttribute("data-ground")).toBe("paper");

    const heading = doc.querySelector("h2");
    expect(heading?.querySelector(".sr-only")?.textContent).toBe("Confidential per operation.");
    expect(doc.body.textContent).toContain("shielded rings.");

    const link = doc.querySelector("a");
    expect(link?.textContent).toBe("See the policies");
    expect(link?.getAttribute("href")).toBe("/policies");
    expect(link?.hasAttribute("target")).toBe(false);
    expect(link?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("PrivacyBubble", () => {
  it("is a labelled picture, not a control", () => {
    const { container } = render(<PrivacyBubble label={label} words={words} />);

    const picture = screen.getByRole("img", { name: label });
    expect(picture).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(container.querySelector("button, a, input, [tabindex]")).toBeNull();
    expect(currentWord(picture)).toBe("Payments");
  });

  it("stays on its first word under reduced motion", () => {
    motion.reduced = true;
    vi.useFakeTimers();
    render(<PrivacyBubble label={label} words={words} />);
    const picture = screen.getByRole("img");

    expect(observerCallback).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(currentWord(picture)).toBe("Payments");
    expect(picture.hasAttribute("data-tg")).toBe(false);
    expect(picture.hasAttribute("data-on")).toBe(false);
  });

  it("folds into a switch, turns it on and opens on the next word, then stops on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = render(<PrivacyBubble label={label} words={words} />);
    const picture = screen.getByRole("img");
    showBubble();

    act(() => {
      vi.advanceTimersByTime(900 + 2400);
    });
    expect(picture.hasAttribute("data-tg")).toBe(true);
    expect(picture.hasAttribute("data-off")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(picture.hasAttribute("data-on")).toBe(true);
    expect(picture.hasAttribute("data-off")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(picture.hasAttribute("data-tg")).toBe(false);
    expect(currentWord(picture)).toBe("Issuance");

    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not advance while off screen", () => {
    vi.useFakeTimers();
    render(<PrivacyBubble label={label} words={words} />);
    const picture = screen.getByRole("img");

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(picture.hasAttribute("data-tg")).toBe(false);
    expect(currentWord(picture)).toBe("Payments");
  });
});
