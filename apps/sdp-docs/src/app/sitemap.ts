import { docsOrigin, getDocsPagePath } from "@/lib/site";
import { source } from "@/lib/source";
import type { MetadataRoute } from "next";

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
      url: `${docsOrigin}/llms.txt`,
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${docsOrigin}/llms-full.txt`,
      changeFrequency: "weekly",
      priority: 0.5,
    },
    ...docEntries,
  ];
}
