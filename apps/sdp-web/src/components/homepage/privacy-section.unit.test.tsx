// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { setReducedMotion, stubMatchMedia } from "@/test/media-queries";
import {
  type FakeIntersectionObserver,
  intersect,
  stubIntersectionObserver,
} from "@/test/visibility";

vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getRequestLocale: async () => "en",
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import { PrivacyBubble } from "./privacy/privacy-bubble";
import { PrivacySection } from "./privacy-section";

const words = ["Payments", "Issuance", "Markets", "Payroll", "Balances"];
const label = "What stays private: payments, issuance, markets, payroll, balances";

let observers: readonly FakeIntersectionObserver[] = [];

function currentWord(bubble: HTMLElement) {
  return bubble.querySelector("[data-current]")?.textContent;
}

beforeEach(() => {
  // jsdom has no font loading
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  observers = stubIntersectionObserver();
  // a narrow screen: the cycle starts without the wide-screen stagger
  stubMatchMedia(() => true);
  setReducedMotion(false);
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
    expect(section?.getAttribute("data-ground")).toBe("panel");

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
    setReducedMotion(true);
    vi.useFakeTimers();
    render(<PrivacyBubble label={label} words={words} />);
    const picture = screen.getByRole("img");

    expect(observers).toHaveLength(0);
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
    intersect(true);

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
    for (const observer of observers) expect(observer.disconnect).toHaveBeenCalled();
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
