import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Solana Developer Platform",
  description: "SDP dashboard",
};

const clerkSignInUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL || "/sign-in";
const clerkSignUpUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL || "/sign-up";
const clerkSignInFallbackRedirectUrl =
  process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL || "/dashboard";
const clerkSignUpFallbackRedirectUrl =
  process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL || "/dashboard";
const clerkSignInForceRedirectUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FORCE_REDIRECT_URL;
const clerkSignUpForceRedirectUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FORCE_REDIRECT_URL;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ClerkProvider
          signInUrl={clerkSignInUrl}
          signUpUrl={clerkSignUpUrl}
          signInFallbackRedirectUrl={clerkSignInFallbackRedirectUrl}
          signUpFallbackRedirectUrl={clerkSignUpFallbackRedirectUrl}
          signInForceRedirectUrl={clerkSignInForceRedirectUrl}
          signUpForceRedirectUrl={clerkSignUpForceRedirectUrl}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
