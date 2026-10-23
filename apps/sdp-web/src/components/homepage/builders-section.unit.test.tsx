// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages, type MessageKey } from "@/i18n/messages";
import { type TranslationValues, translate } from "@/i18n/translate";

function t(key: MessageKey, values?: TranslationValues) {
  return translate(getMessages("en"), key, values);
}

vi.mock("@/i18n/server", () => ({ getTranslations: async () => t }));

import { FILMS, filmUrl, SERIES_URL } from "./builders/films";
import { BuildersSection } from "./builders-section";

async function renderBuilders() {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(await BuildersSection());
  return root;
}

describe("BuildersSection", () => {
  it("is a named dark panel the bar reads as paper, with one h2", async () => {
    const root = await renderBuilders();
    const section = root.querySelector("section");
    expect(section?.id).toBe("builders");
    expect(section?.dataset.ground).toBe("panel");
    expect(section?.getAttribute("aria-label")).toBe("Meet the builders");
    const headings = root.querySelectorAll("h1, h2, h3");
    expect(headings).toHaveLength(1);
    expect(headings[0].querySelector(".sr-only")?.textContent).toBe("Meet the builders");
  });

  it("shows every film as a face that opens YouTube in a new tab", async () => {
    const root = await renderBuilders();
    const list = root.querySelector("ul");
    expect(list?.getAttribute("aria-label")).toBe("The films");
    const links = [...root.querySelectorAll("a")];
    for (const film of FILMS) {
      const link = links.find((a) => a.href === filmUrl(film.id));
      expect(link?.target).toBe("_blank");
      expect(link?.rel).toBe("noreferrer");
      expect(link?.getAttribute("aria-label")).toBe(
        `${film.name}: watch the conversation on YouTube (opens in a new tab)`
      );
      expect(link?.textContent).toBe(film.name);
      expect(link?.querySelector("img")?.getAttribute("alt")).toBe("");
    }
  });

  it("leads to the whole series", async () => {
    const root = await renderBuilders();
    const series = [...root.querySelectorAll("a")].filter((a) => a.href === SERIES_URL);
    expect(series).toHaveLength(1);
    expect(series[0].target).toBe("_blank");
    expect(series[0].getAttribute("aria-label")).toContain("opens in a new tab");
  });
});
