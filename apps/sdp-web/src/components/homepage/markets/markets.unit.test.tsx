// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { EnglishI18n } from "@/test/i18n";
import { intersect, stubIntersectionObserver } from "@/test/visibility";

vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getRequestLocale: async () => "en",
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import { MarketsSection } from "@/components/homepage/markets-section";
import { MarketsChart, rateAt, yAtX } from "./markets-chart";

beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarketsSection", () => {
  async function parse() {
    const markup = renderToStaticMarkup(<EnglishI18n>{await MarketsSection()}</EnglishI18n>);
    return new DOMParser().parseFromString(markup, "text/html");
  }

  it("renders the dark panel section with its h2, paragraph and sandbox link", async () => {
    const doc = await parse();
    const section = doc.querySelector("section#markets");
    expect(section?.getAttribute("data-ground")).toBe("panel");

    const heading = doc.querySelector("h2");
    expect(heading?.querySelector(".sr-only")?.textContent).toBe("Earn on it. Settle against it.");
    expect(doc.body.textContent).toContain("leave escrow together, or neither does.");

    const link = doc.querySelector("a");
    expect(link?.textContent).toBe("Open markets in the sandbox");
    expect(link?.getAttribute("href")).toBe("/dashboard/markets");
    expect(link?.hasAttribute("target")).toBe(false);
    expect(link?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives the chart a text alternative and hides the drawing", async () => {
    const doc = await parse();
    const figure = doc.querySelector("figure");
    expect(figure?.querySelector("figcaption")?.textContent).toContain(
      "curated DeFi climbs to up to 8% a year"
    );
    for (const svg of figure?.querySelectorAll("svg") ?? []) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
    // the legend and figures stay readable; the axis words and the hover bubble do not
    expect(figure?.textContent).toContain("Tokenized treasuries · ~4.5%");
    expect(figure?.textContent).toContain("3.5–8%");
    expect(figure?.textContent).toContain("to withdraw, either strategy");
    expect(doc.querySelector("figure > div[aria-hidden='true']")?.textContent).toBe(
      "IdleDeployedToday"
    );
  });
});

describe("MarketsChart", () => {
  it("starts undrawn and draws in the first time it is on screen", () => {
    const { container } = render(<MarketsChart />, { wrapper: EnglishI18n });
    const figure = container.querySelector("figure");
    if (!figure) throw new Error("no figure");
    expect(figure.getAttribute("data-drawn")).toBe("false");

    intersect(true);
    expect(figure.getAttribute("data-drawn")).toBe("true");
    expect(figure.getAttribute("data-on-screen")).toBe("true");
  });

  it("uses gradient ids a url() reference can take", () => {
    const { container } = render(<MarketsChart />, { wrapper: EnglishI18n });
    for (const gradient of container.querySelectorAll("linearGradient")) {
      expect(gradient.id).toMatch(/^[a-zA-Z0-9-]+$/);
    }
  });
});

describe("helpers", () => {
  it("finds the y of a line at an x", () => {
    // a straight line from (0, 100) to (100, 0), its length along x
    const y = yAtX((length) => ({ x: length, y: 100 - length }), 100, 25);
    expect(y).toBeCloseTo(75, 3);
  });

  it("reads a rate from a height, 0 at the baseline and the max at the peak", () => {
    expect(rateAt(100, 100, 10, 8)).toBe(0);
    expect(rateAt(10, 100, 10, 8)).toBe(8);
    expect(rateAt(55, 100, 10, 8)).toBe(4);
    expect(rateAt(120, 100, 10, 8)).toBe(0);
  });
});
