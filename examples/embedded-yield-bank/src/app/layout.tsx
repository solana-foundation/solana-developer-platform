import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/inter/index.css";
import "../index.css";

const title = "Northstar Bank";
const description =
  "Checking and savings in one place. Savings earn on-chain yield through Solana Earn.";

export const metadata: Metadata = {
  // Unfurlers need absolute image URLs. Vercel exposes the production host;
  // anything else resolves against the local dev server.
  metadataBase: new URL(
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://127.0.0.1:4173"
  ),
  title,
  description,
  applicationName: title,
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  openGraph: { type: "website", siteName: title, title, description },
  twitter: { card: "summary_large_image", title, description },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
