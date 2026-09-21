import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Keep the demo chrome-free in development too.
  devIndicators: false,
  // The demo must never be discoverable through search. This header covers
  // every response, including the public favicon, social card, and robots.txt
  // that sit outside the Basic-auth proxy.
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        {
          key: "X-Robots-Tag",
          value: "noindex, nofollow, noarchive, nosnippet, noimageindex",
        },
      ],
    },
  ],
};

export default nextConfig;
