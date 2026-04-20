import type { MetadataRoute } from "next";
import { docsOrigin } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
    ],
    sitemap: `${docsOrigin}/sitemap.xml`,
    host: docsOrigin,
  };
}
