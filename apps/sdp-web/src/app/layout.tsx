import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { AppToaster } from "@/components/app-toaster";
import { ClerkClientProvider } from "@/components/clerk-client-provider";
import { ThemeProvider } from "@/contexts/theme-context";
import { I18nProvider } from "@/i18n/provider";
import { getI18nRequest, getTranslations } from "@/i18n/server";
import { shouldLoadClerkForPath } from "@/lib/auth-entry";
import "./globals.css";
import Script from "next/script";

// The app's faces, from the design-tokens package so a Storybook loads the same files.
// tokens.css points --font-sans and --font-mono at the two variables on :root.
const seasonSans = localFont({
  src: [
    {
      path: "../../../../packages/sdp-design-tokens/src/assets/fonts/SeasonSans-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../../../packages/sdp-design-tokens/src/assets/fonts/SeasonSans-Medium.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--font-season-sans",
  display: "swap",
});

const geistMono = localFont({
  src: "../../../../packages/sdp-design-tokens/src/assets/fonts/GeistMono-Variable-latin.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-geist-mono",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const title = t("Metadata.title");
  const description = t("Metadata.description");
  return {
    // Resolves the og/twitter image file conventions to absolute URLs, which
    // link unfurlers require. Vercel previews inherit the canonical origin on
    // purpose: preview links unfurl with production media instead of leaking
    // preview hostnames into caches.
    metadataBase: new URL(process.env.NEXT_PUBLIC_SDP_WEB_URL ?? "https://platform.solana.com"),
    title: {
      default: title,
      template: `%s · ${title}`,
    },
    description,
    applicationName: title,
    openGraph: {
      type: "website",
      siteName: title,
      title,
      description,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
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
    <html
      lang={locale}
      className={`${seasonSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {process.env.NODE_ENV === "development" && (
          // react-grab lets developers select page context for coding agents
          // directly from the running site. Dev-only: this never loads in
          // production. The version and integrity hash are pinned so `pnpm
          // dev` cannot silently execute a different build than the one
          // reviewed here.
          <Script
            src="https://unpkg.com/react-grab@0.2.0/dist/index.global.js"
            integrity="sha384-PXOWAzllLihCpnqFflLZrth6D6UsI8PqPYbA6qYnE44Cld6haJIBjLZR4onqH+3z"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        )}
      </head>
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
