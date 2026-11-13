// @vitest-environment jsdom
import { SDP_TERMS } from "@sdp/types/mainnet-access";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";

vi.mock("@/flags", () => ({ betaLabel: async () => false }));
vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import TermsPage from "./page";

async function renderPage() {
  const html = renderToStaticMarkup(await TermsPage());
  return new DOMParser().parseFromString(html, "text/html");
}

describe("TermsPage", () => {
  it("titles the page with the terms and their date", async () => {
    const doc = await renderPage();
    expect(doc.querySelector("h1")?.textContent).toBe(SDP_TERMS.title);
    expect(doc.body.textContent).toContain(SDP_TERMS.effectiveDate);
  });

  it("draws every section and subsection of the text the API records", async () => {
    const doc = await renderPage();
    expect(Array.from(doc.querySelectorAll("h2"), (h) => h.textContent)).toEqual(
      SDP_TERMS.sections.map((section) => section.heading)
    );
    expect(Array.from(doc.querySelectorAll("h3"), (h) => h.textContent)).toEqual(
      SDP_TERMS.sections.flatMap((section) =>
        section.blocks.flatMap((block) => (block.kind === "subheading" ? [block.text] : []))
      )
    );
  });

  it("draws each list item and bold run, without the source's markers", async () => {
    const doc = await renderPage();
    const items = SDP_TERMS.sections.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "list" ? block.items : []))
    );
    expect(doc.querySelectorAll("li")).toHaveLength(items.length);
    expect(doc.querySelector("strong")?.textContent).toBe("Company");
    expect(doc.body.textContent).not.toContain("**");
  });

  it("keys every block uniquely", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderPage();
    expect(error.mock.calls.flat().join("\n")).not.toContain("same key");
    error.mockRestore();
  });
});
