import type { Metadata } from "next";
import "fumadocs-ui/style.css";
import { docsOrigin, docsUrl } from "@/lib/site";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";

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
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
