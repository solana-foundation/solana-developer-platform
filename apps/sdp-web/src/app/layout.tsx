import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Solana Developer Platform",
  description: "SDP dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ClerkProvider
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          signInFallbackRedirectUrl="/dashboard"
          signUpFallbackRedirectUrl="/dashboard"
        >
          {children}
          <Toaster position="top-right" richColors closeButton />
        </ClerkProvider>
      </body>
    </html>
  );
}
