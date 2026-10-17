// @vitest-environment jsdom
import { SDP_GITHUB_REPO_URL } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { HomepageLinks } from "./homepage-links";

vi.mock("@/i18n/server", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import { HomepageFooter } from "./homepage-footer";

const links: HomepageLinks = {
  signup: { href: "/sign-up", label: "Create account", external: false },
  signIn: "/sign-in",
  docs: "https://docs.example/docs",
  openapi: "https://docs.example/docs/reference/api",
  llms: "https://docs.example/docs/ai/llms.txt",
};

async function renderFooter() {
  const html = renderToStaticMarkup(await HomepageFooter({ links }));
  return new DOMParser().parseFromString(html, "text/html");
}

describe("HomepageFooter", () => {
  it("is the page's footer on the night ground", async () => {
    const doc = await renderFooter();
    const footer = doc.querySelector("footer#footer");
    expect(footer?.getAttribute("data-ground")).toBe("night");
  });

  it("names its three columns with h2 headings, after the close's h2", async () => {
    const doc = await renderFooter();
    const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4"));
    expect(headings.map((h) => h.tagName)).toEqual(["H2", "H2", "H2"]);
    expect(headings.map((h) => h.textContent)).toEqual(["Platform", "Developers", "Ecosystem"]);
  });

  it("links home through the lockup, named for screen readers", async () => {
    const doc = await renderFooter();
    const brand = doc.querySelector('a[href="/"]');
    expect(brand?.getAttribute("aria-label")).toBe("SDP home");
    expect(brand?.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("points every link at a real target", async () => {
    const doc = await renderFooter();
    const hrefs = Object.fromEntries(
      Array.from(doc.querySelectorAll("li a")).map((a) => [a.textContent, a.getAttribute("href")])
    );
    expect(hrefs).toEqual({
      Issuance: "#issuance",
      Payments: "#payments",
      Markets: "#markets",
      Privacy: "#privacy",
      Interfaces: "#interfaces",
      Docs: links.docs,
      OpenAPI: links.openapi,
      GitHub: SDP_GITHUB_REPO_URL,
      Partners: "#stack",
      Builders: "#builders",
      Tutorials: "#blog",
    });
  });

  it("names who provides the platform", async () => {
    const doc = await renderFooter();
    expect(doc.body.textContent).toContain("Provided by the Solana Foundation");
  });
});
