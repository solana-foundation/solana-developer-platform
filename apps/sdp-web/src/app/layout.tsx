import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { shouldLoadClerkForPath } from "@/lib/auth-entry";
import "./globals.css";

const ALLOWED_SATELLITE_REDIRECT_ORIGINS = [
  "https://ecosystem.solana.com",
  "https://bookface-git-main-solana-foundation.vercel.app",
];

export const metadata: Metadata = {
  title: "Solana Developer Platform",
  description: "SDP dashboard",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = (await headers()).get("x-sdp-pathname") ?? "/";
  const shouldLoadClerk = await shouldLoadClerkForPath(pathname);
  const content = shouldLoadClerk ? (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      allowedRedirectOrigins={ALLOWED_SATELLITE_REDIRECT_ORIGINS}
      afterSignOutUrl="/sign-in"
    >
      {children}
    </ClerkProvider>
  ) : (
    children
  );

  return (
    <html lang="en">
      <body>
        {content}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
