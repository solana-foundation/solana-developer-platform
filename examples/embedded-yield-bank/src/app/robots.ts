import type { MetadataRoute } from "next";

/** A devnet demo behind Basic auth has no business in search results. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
