import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { EnglishI18n } from "@/test/i18n";

vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import { NetworkSection } from "./network-section";

async function render() {
  return renderToStaticMarkup(<EnglishI18n>{await NetworkSection()}</EnglishI18n>);
}

describe("NetworkSection", () => {
  it("keeps its anchor and is a dark panel the bar reads as paper", async () => {
    const markup = await render();
    expect(markup).toMatch(/^<section id="network" data-ground="panel"/);
  });

  it("names the section with one h2 read as the whole sentence", async () => {
    const markup = await render();
    expect(markup.match(/<h2/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<h[13]/);
    expect(markup).toContain('<span class="sr-only">Settled everywhere, under a second.</span>');
  });

  it("describes the race canvas as an image and keeps the lane names as text", async () => {
    const markup = await render();
    expect(markup).toContain(
      'role="img" aria-label="The same payment on four rails: Solana settles in under a second while the others take days"'
    );
    for (const lane of [
      "Solana, via SDP",
      "~0.4 s",
      "Card networks",
      "ACH",
      "SWIFT",
      "1 to 5 days",
    ]) {
      expect(markup).toContain(lane);
    }
  });

  it("hides the illustrative settlements list from assistive tech", async () => {
    const markup = await render();
    expect(markup).toMatch(/aria-hidden="true"><div[^>]*>Settled on Solana<\/div>/);
    expect(markup).not.toContain("aria-live");
  });

  it("renders every figure at its final value, read once", async () => {
    const markup = await render();
    expect(markup).toContain("&lt;1 s");
    for (const value of ["30+", "200+", "1"]) {
      expect(markup).toContain(
        `<span aria-hidden="true">${value}</span><span class="sr-only">${value}</span>`
      );
    }
    expect(markup).toContain("partners behind one integration");
  });
});
