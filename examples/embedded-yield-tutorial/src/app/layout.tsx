import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/inter/index.css";
import "../index.css";

export const metadata: Metadata = {
  title: "Stablecoin Savings Account for Your Users",
  description:
    "An interactive walkthrough of Embedded Yield on the Solana Developer Platform: custody, configure, and earn, illustrated.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
