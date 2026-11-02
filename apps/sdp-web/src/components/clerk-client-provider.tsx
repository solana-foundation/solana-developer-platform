"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";

const ALLOWED_SATELLITE_REDIRECT_ORIGINS = [
  "https://ecosystem.solana.com",
  "https://bookface-git-main-solana-foundation.vercel.app",
];

/**
 * Clerk reads the native --clerk-* variables declared in sdp-theme.css. This
 * keeps its first paint synchronized with the pre-hydration root theme class.
 */
export function ClerkClientProvider({ children }: { children: ReactNode }) {
  const t = useTranslations();

  return (
    <ClerkProvider
      appearance={{
        cssLayerName: "clerk",
        elements: {
          socialButtonsProviderIcon__github: {
            filter: "var(--sdp-clerk-provider-icon-filter)",
          },
        },
      }}
      localization={{
        formFieldInputPlaceholder__emailAddress: t("Shared.authShell.emailPlaceholder"),
        formFieldInputPlaceholder__password: "",
        formFieldInputPlaceholder__signUpPassword: "",
        signIn: {
          forgotPasswordAlternativeMethods: { title: t("Shared.authShell.forgotPasswordTitle") },
        },
      }}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      allowedRedirectOrigins={ALLOWED_SATELLITE_REDIRECT_ORIGINS}
      afterSignOutUrl="/sign-in"
    >
      {children}
    </ClerkProvider>
  );
}
