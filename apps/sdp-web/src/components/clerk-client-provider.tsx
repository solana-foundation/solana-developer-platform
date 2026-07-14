"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { type ReactNode, useMemo } from "react";
import { useTheme } from "@/contexts/theme-context";

const ALLOWED_SATELLITE_REDIRECT_ORIGINS = [
  "https://ecosystem.solana.com",
  "https://bookface-git-main-solana-foundation.vercel.app",
];

// Dark theming via Clerk's stable appearance API (not @clerk/themes, whose
// latest release trails this Clerk version and silently no-ops).
//
// clerk-js is loaded remotely and honors the full variable set — notably
// `colorNeutral`, which generates the neutral scale that most text (headings,
// labels, popover rows) derives from. Dropping it (or `colorText`) reverts that
// text to clerk-js's light-mode defaults = dark-on-dark. Keep the whole set.
//
// colorPrimary is kept near-white to match the app's dark-mode primary buttons
// (light fill, dark text) and to keep footer links legible on the dark card.
const CLERK_DARK_VARIABLES = {
  colorBackground: "#26262a", // raised card
  colorText: "#fcfcfa",
  colorTextSecondary: "rgba(252, 252, 250, 0.72)",
  colorNeutral: "#fcfcfa",
  colorInputBackground: "#1c1c1d",
  colorInputText: "#fcfcfa",
  colorPrimary: "#fcfcfa",
  colorTextOnPrimaryBackground: "#1c1c1d",
  colorShimmer: "rgba(252, 252, 250, 0.10)",
  colorDanger: "#ef4444",
  colorSuccess: "#34d399",
  colorWarning: "#fbbf24",
};

const CLERK_DARK_ELEMENTS = {
  formFieldInput: {
    backgroundColor: "#1c1c1d",
    color: "#fcfcfa",
    borderColor: "rgba(252, 252, 250, 0.12)",
  },
  formButtonPrimary: {
    color: "#1c1c1d",
  },
};

/**
 * Wraps Clerk so its widgets (UserButton, OrganizationSwitcher, sign-in/up)
 * follow the app theme. 
 */
export function ClerkClientProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const { theme } = useTheme();
  const appearance = useMemo(
    () =>
      theme === "dark"
        ? { variables: CLERK_DARK_VARIABLES, elements: CLERK_DARK_ELEMENTS }
        : undefined,
    [theme]
  );

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      allowedRedirectOrigins={ALLOWED_SATELLITE_REDIRECT_ORIGINS}
      afterSignOutUrl="/sign-in"
      appearance={appearance}
    >
      {children}
    </ClerkProvider>
  );
}
