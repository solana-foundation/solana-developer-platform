import { refreshThemeProps } from "@sdp/design-tokens";
import type { Metadata } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import "fumadocs-ui/style.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { docsOrigin, docsUrl } from "@/lib/site";
import "./globals.css";

// The refresh design's faces, loaded from @sdp/design-tokens the way sdp-web loads them. tokens.css
// reads the two variables inside [data-sdp-theme="refresh"], which <html> carries.
const seasonSans = localFont({
  src: [
    {
      path: "../../../../packages/sdp-design-tokens/src/assets/fonts/SeasonSans-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../../../packages/sdp-design-tokens/src/assets/fonts/SeasonSans-Medium.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--font-season-sans",
  display: "swap",
});

const geistMono = localFont({
  src: "../../../../packages/sdp-design-tokens/src/assets/fonts/GeistMono-Variable-latin.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Solana Developer Platform Documentation",
  description: "Documentation for Solana Developer Platform",
  metadataBase: new URL(docsOrigin),
  alternates: {
    canonical: docsUrl,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      {...refreshThemeProps}
      className={`${seasonSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {process.env.NODE_ENV === "development" && (
          // react-grab lets developers select page context for coding agents
          // directly from the running site. Dev-only: this never loads in
          // production. The version and integrity hash are pinned so `pnpm
          // dev` cannot silently execute a different build than the one
          // reviewed here.
          <Script
            src="https://unpkg.com/react-grab@0.2.0/dist/index.global.js"
            integrity="sha384-PXOWAzllLihCpnqFflLZrth6D6UsI8PqPYbA6qYnE44Cld6haJIBjLZR4onqH+3z"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        )}
      </head>
      <body className="antialiased">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
