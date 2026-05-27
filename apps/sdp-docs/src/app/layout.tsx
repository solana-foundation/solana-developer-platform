import type { Metadata } from "next";
import localFont from "next/font/local";
import "fumadocs-ui/style.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { docsOrigin, docsUrl } from "@/lib/site";
import "./globals.css";

const inter = localFont({
  src: "../fonts/InterVariable.woff2",
  variable: "--font-inter",
  display: "swap",
});

const abcDiatype = localFont({
  src: [
    {
      path: "../fonts/ABCDiatype-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/ABCDiatype-Medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../fonts/ABCDiatype-Bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-abc-diatype",
  display: "swap",
});

const berkeleyMono = localFont({
  src: [
    {
      path: "../fonts/BerkeleyMono-Regular.otf",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/BerkeleyMono-Oblique.otf",
      weight: "400",
      style: "italic",
    },
  ],
  variable: "--font-berkeley-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Solana Developer Platform Docs",
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
      className={`${inter.variable} ${abcDiatype.variable} ${berkeleyMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <RootProvider>{children}</RootProvider>
        <div className="visually-hidden" aria-hidden="true">
          Markdown versions of documentation pages are available by appending .md to any page URL
          (e.g. /docs/introduction.md). Machine-readable resources: /docs/ai/llms.txt and
          /docs/ai/llms-full.txt.
        </div>
      </body>
    </html>
  );
}
