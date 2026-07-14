import type { Metadata } from "next";
import { headers } from "next/headers";
import { AppToaster } from "@/components/app-toaster";
import { ClerkClientProvider } from "@/components/clerk-client-provider";
import { THEME_NO_FLASH_SCRIPT, ThemeProvider } from "@/contexts/theme-context";
import { I18nProvider } from "@/i18n/provider";
import { getI18nRequest, getTranslations } from "@/i18n/server";
import { shouldLoadClerkForPath } from "@/lib/auth-entry";
import "./globals.css";

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

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: render-blocking theme script must run before hydration to avoid a flash of the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <I18nProvider locale={locale} messages={messages}>
            <ClerkClientProvider enabled={shouldLoadClerk}>{children}</ClerkClientProvider>
            <AppToaster />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
