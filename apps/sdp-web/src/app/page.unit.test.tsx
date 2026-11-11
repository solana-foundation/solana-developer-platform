import type { ResolvingMetadata } from "next";
import { createDefaultMetadata } from "next/dist/lib/metadata/default-metadata";
import { describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";

vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getRequestLocale: async () => "en",
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import catalog from "@/messages/en/homepage.json";
import site from "@/messages/en.json";
import { generateMetadata } from "./page";

const ogImages = [{ url: "https://platform.solana.com/opengraph-image.png" }];
const twitterImages = [{ url: "https://platform.solana.com/twitter-image.png" }];

const props = { searchParams: Promise.resolve({}) };

/** The layout's resolved metadata, as the page receives it: a share card with its images. */
function parent(): ResolvingMetadata {
  const title = { absolute: site.Metadata.title, template: null };
  return Promise.resolve({
    ...createDefaultMetadata(),
    openGraph: { type: "website", title, url: null, images: ogImages },
    twitter: {
      card: "summary_large_image",
      title,
      site: null,
      siteId: null,
      creator: null,
      creatorId: null,
      description: null,
      images: twitterImages,
    },
  });
}

describe("homepage metadata", () => {
  it("describes the homepage on its own, in the page, the card and the share", async () => {
    const metadata = await generateMetadata(props, parent());
    const description = catalog.Homepage.metadata.description;
    expect(metadata.description).toBe(description);
    expect(metadata.openGraph?.description).toBe(description);
    expect(metadata.twitter?.description).toBe(description);
    expect(metadata.description).not.toBe(site.Metadata.description);
  });

  it("keeps the layout's share images, title and card", async () => {
    const metadata = await generateMetadata(props, parent());
    expect(metadata.openGraph?.images).toBe(ogImages);
    expect(metadata.twitter?.images).toBe(twitterImages);
    expect(metadata.openGraph?.title).toBe(site.Metadata.title);
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });
});
