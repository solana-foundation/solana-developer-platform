import { shouldLoadClerkForPath } from "@/lib/auth-entry";
import { ClerkProvider } from "@clerk/nextjs";
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
  const pathname = (await headers()).get("x-sdp-pathname") ?? "/";
  const shouldLoadClerk = shouldLoadClerkForPath(pathname);

  return (
    <html lang="en">
      <body>
        {shouldLoadClerk ? (
          <ClerkProvider
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
            signInFallbackRedirectUrl="/dashboard"
            signUpFallbackRedirectUrl="/dashboard"
          >
            {children}
            <Toaster position="top-right" richColors closeButton />
          </ClerkProvider>
        ) : (
          <>
            {children}
            <Toaster position="top-right" richColors closeButton />
          </>
        )}
      </body>
    </html>
  );
}
