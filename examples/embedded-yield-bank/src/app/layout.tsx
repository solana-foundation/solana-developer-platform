import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/inter/index.css";
import "../index.css";

export const metadata: Metadata = {
  title: "Northstar Bank",
  description: "A full-stack Embedded Yield example powered by SDP.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
