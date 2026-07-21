"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";

const ALLOWED_SATELLITE_REDIRECT_ORIGINS = [
  "https://ecosystem.solana.com",
  "https://bookface-git-main-solana-foundation.vercel.app",
];

/**
 * Clerk reads the native --clerk-* variables declared in sdp-theme.css. This
 * keeps its first paint synchronized with the pre-hydration root theme class.
 */
export function ClerkClientProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      appearance={{
        elements: {
          socialButtonsProviderIcon__github: {
            filter: "var(--sdp-clerk-provider-icon-filter)",
          },
        },
      }}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      taskUrls={{ "choose-organization": "/sign-up/tasks/choose-organization" }}
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      allowedRedirectOrigins={ALLOWED_SATELLITE_REDIRECT_ORIGINS}
      afterSignOutUrl="/sign-in"
    >
      {children}
    </ClerkProvider>
  );
}
