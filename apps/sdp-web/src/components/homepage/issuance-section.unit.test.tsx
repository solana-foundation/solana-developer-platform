// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { EnglishI18n } from "@/test/i18n";
import { setReducedMotion, stubMatchMedia } from "@/test/media-queries";

vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getRequestLocale: async () => "en",
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import {
  type FakeIntersectionObserver,
  intersect,
  stubIntersectionObserver,
} from "@/test/visibility";
import { IssuanceSection } from "./issuance-section";
import { IssuanceSheet } from "./issuance-sheet";

let observers: readonly FakeIntersectionObserver[] = [];

beforeEach(() => {
  stubMatchMedia();
  setReducedMotion(false);
  observers = stubIntersectionObserver();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("IssuanceSection", () => {
  it("renders the section landmark with its heading, copy and sandbox link", async () => {
    const markup = renderToStaticMarkup(<EnglishI18n>{await IssuanceSection()}</EnglishI18n>);
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
    render(<IssuanceSheet />, { wrapper: EnglishI18n });
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
    setReducedMotion(true);
    vi.useFakeTimers();
    render(<IssuanceSheet />, { wrapper: EnglishI18n });

    expect(observers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("100,000,000")).toBeTruthy();
  });

  it("runs the lifecycle while on screen and stops on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = render(<IssuanceSheet />, { wrapper: EnglishI18n });
    intersect(true);

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
    for (const observer of observers) expect(observer.disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not advance while off screen", () => {
    vi.useFakeTimers();
    render(<IssuanceSheet />, { wrapper: EnglishI18n });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("Live")).toBeTruthy();
  });
});
