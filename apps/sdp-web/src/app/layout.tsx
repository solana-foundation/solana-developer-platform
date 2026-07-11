import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { I18nProvider } from "@/i18n/provider";
import { getI18nRequest, getTranslations } from "@/i18n/server";
import { shouldLoadClerkForPath } from "@/lib/auth-entry";
import "./globals.css";

const ALLOWED_SATELLITE_REDIRECT_ORIGINS = [
  "https://ecosystem.solana.com",
  "https://bookface-git-main-solana-foundation.vercel.app",
];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return {
    title: t("Metadata.title"),
    description: t("Metadata.description"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = (await headers()).get("x-sdp-pathname") ?? "/";
  const { locale, messages } = await getI18nRequest();
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
    <html lang={locale}>
      <body>
        <I18nProvider locale={locale} messages={messages}>
          {content}
          <Toaster position="bottom-right" richColors closeButton />
        </I18nProvider>
      </body>
    </html>
  );
}
