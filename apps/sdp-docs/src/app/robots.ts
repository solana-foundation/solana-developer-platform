import { docsOrigin } from "@/lib/site";
import type { MetadataRoute } from "next";

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
