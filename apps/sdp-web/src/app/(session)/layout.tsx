import { ClerkProvider } from "@clerk/nextjs";
import { ui } from "@clerk/ui";
import type { ReactNode } from "react";
import { getTranslations } from "@/i18n/server";

const ALLOWED_SATELLITE_REDIRECT_ORIGINS = [
  "https://ecosystem.solana.com",
  "https://bookface-git-main-solana-foundation.vercel.app",
];

// `dynamic` hands the request's auth to the client as initial state, so `useAuth()` is loaded on
// the server render and the first client render instead of after clerk-js boots. Clerk reads the
// native --clerk-* variables declared in sdp-theme.css, which keeps its first paint in step with
// the pre-hydration root theme class.
export default async function SessionLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations();

  return (
    <ClerkProvider
      dynamic
      ui={ui}
      prefetchUI={false}
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
