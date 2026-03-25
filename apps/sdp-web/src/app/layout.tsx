import { shouldLoadClerkForPath } from "@/lib/auth-entry";
import { ClerkProvider } from "@clerk/nextjs";
import { VercelToolbar } from "@vercel/toolbar/next";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Solana Developer Platform",
  description: "SDP dashboard",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const shouldInjectToolbar = process.env.NODE_ENV === "development";
  const pathname = (await headers()).get("x-sdp-pathname") ?? "/";
  const shouldLoadClerk = await shouldLoadClerkForPath(pathname);
  const content = shouldLoadClerk ? (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
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
        <Toaster position="top-right" richColors closeButton />
        {shouldInjectToolbar ? <VercelToolbar /> : null}
      </body>
    </html>
  );
}
