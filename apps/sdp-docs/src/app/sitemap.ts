import type { MetadataRoute } from "next";
import { aiLlmsFullUrl, aiLlmsUrl, docsOrigin, getDocsPagePath } from "@/lib/site";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const docEntries = source.generateParams().map(({ slug }) => {
    const pageSlug = Array.isArray(slug) ? slug.join("/") : "";

    return {
      url: `${docsOrigin}${getDocsPagePath(pageSlug)}`,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    };
  });

  return [
    {
      url: `${docsOrigin}/docs`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: aiLlmsUrl,
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: aiLlmsFullUrl,
      changeFrequency: "weekly",
      priority: 0.5,
    },
    ...docEntries,
  ];
}
