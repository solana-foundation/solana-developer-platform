import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/server", async () => {
  const { translate } = await import("@/i18n/translate");
  const { default: messages } = await import("../../../messages/en/homepage.json");
  return {
    getTranslations: async () => (key: string, values?: Record<string, string | number>) =>
      translate(messages, key as never, values),
  };
});

vi.mock("@/i18n/provider", async () => {
  const { translate } = await import("@/i18n/translate");
  const { default: messages } = await import("../../../messages/en/homepage.json");
  return {
    useLocale: () => "en",
    useTranslations: () => (key: string, values?: Record<string, string | number>) =>
      translate(messages, key as never, values),
  };
});

import { NetworkSection } from "./network-section";

async function render() {
  return renderToStaticMarkup(await NetworkSection());
}

describe("NetworkSection", () => {
  it("keeps its anchor and paper ground", async () => {
    const markup = await render();
    expect(markup).toMatch(/^<section id="network" data-ground="paper"/);
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
