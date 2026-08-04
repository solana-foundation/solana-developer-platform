import type { Metadata } from "next";
import { Archivo_Narrow } from "next/font/google";
import { headers } from "next/headers";
import { AppToaster } from "@/components/app-toaster";
import { ClerkClientProvider } from "@/components/clerk-client-provider";
import { ThemeProvider } from "@/contexts/theme-context";
import { I18nProvider } from "@/i18n/provider";
import { getI18nRequest, getTranslations } from "@/i18n/server";
import { shouldLoadClerkForPath } from "@/lib/auth-entry";
import "./globals.css";

// The issuance header's exchange-ticker face — the one deliberate exception to
// the Inter-only rule, used for the token symbol and nothing else. Downloaded by
// next/font at build time and served from our own origin, so there is no request
// to Google at runtime. Pared to exactly what the ticker renders: latin subset,
// weight 600, upright — every extra weight or style is another file.
const archivoNarrow = Archivo_Narrow({
  subsets: ["latin"],
  weight: ["600"],
  style: ["normal"],
  variable: "--font-ticker-archivo",
  display: "swap",
});

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
  const appContent = shouldLoadClerk ? (
    <ClerkClientProvider>{children}</ClerkClientProvider>
  ) : (
    children
  );

  return (
    <html lang={locale} className={archivoNarrow.variable} suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <I18nProvider locale={locale} messages={messages}>
            {appContent}
            <AppToaster />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
