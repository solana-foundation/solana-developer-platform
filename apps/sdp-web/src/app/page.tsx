import { auth } from "@clerk/nextjs/server";
import { cn } from "@sdp/ui/cn";
import type { Metadata, ResolvingMetadata } from "next";
import { BuildersSection } from "@/components/homepage/builders-section";
import { HeroSection } from "@/components/homepage/hero-section";
import styles from "@/components/homepage/homepage.module.css";
import { HomepageFooter } from "@/components/homepage/homepage-footer";
import { resolveHomepageLinks } from "@/components/homepage/homepage-links";
import { HomepageNav } from "@/components/homepage/homepage-nav";
import { InterfacesSection } from "@/components/homepage/interfaces-section";
import { IssuanceSection } from "@/components/homepage/issuance-section";
import { homepageRootStyle } from "@/components/homepage/layout";
import { MarketsSection } from "@/components/homepage/markets-section";
import { NetworkSection } from "@/components/homepage/network-section";
import { PaymentsSection } from "@/components/homepage/payments-section";
import { StackSection } from "@/components/homepage/stack-section";
import { StartSection } from "@/components/homepage/start-section";
import { homepageOpenSignup, sandboxOnBeta } from "@/flags";
import { getTranslations } from "@/i18n/server";

/*
 * Without script the page must still read: the blocks that rise in (`data-rise`), the code lines
 * and status that roll in (`data-roll-in`), the letters that form in (`data-form-letter`) and the
 * bubbles that wait on their phrase (`data-form-phrase`) wait on client effects, so a noscript
 * style sets them in their final state (the hero's run on a CSS clock and need none). Stable data
 * attributes, since the CSS modules' class names are hashed. With script it never applies.
 */
const NOSCRIPT_CSS = [
  "[data-rise]{opacity:1!important;transform:none!important;clip-path:none!important}",
  "[data-roll-in]{opacity:1!important;transform:none!important}",
  "[data-form-letter]{color:inherit!important;-webkit-text-stroke:0!important;filter:none!important;opacity:1!important;transform:none!important}",
  "[data-state=hidden] [data-form-phrase]::before{opacity:1!important}",
].join("");

/**
 * The homepage's own description; the rest of the site keeps the layout's. A page that sets
 * `openGraph` or `twitter` replaces the layout's whole object, so the layout's fields come along,
 * and so do the share images it resolved from the file conventions (`opengraph-image.tsx`,
 * `twitter-image.tsx`), which belong to the layout's segment, not the page's.
 */
export async function generateMetadata(
  _props: { searchParams: Promise<Record<string, string | string[] | undefined>> },
  parent: ResolvingMetadata
): Promise<Metadata> {
  const [t, inherited] = await Promise.all([getTranslations(), parent]);
  const title = t("Metadata.title");
  const description = t("Homepage.metadata.description");
  return {
    description,
    openGraph: {
      type: "website",
      siteName: title,
      title,
      description,
      images: inherited.openGraph?.images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: inherited.twitter?.images,
    },
  };
}

export default async function Home() {
  const [t, openSignup, hostedSandbox, { userId }] = await Promise.all([
    getTranslations(),
    homepageOpenSignup(),
    sandboxOnBeta(),
    auth(),
  ]);
  const links = resolveHomepageLinks({
    signedIn: Boolean(userId),
    openSignup,
    hostedSandbox,
    createAccountLabel: t("Homepage.cta.createAccount"),
    joinWaitlistLabel: t("Homepage.cta.joinWaitlist"),
    dashboardLabel: t("Homepage.cta.dashboard"),
    trySandboxLabel: t("Homepage.cta.trySandbox"),
  });

  return (
    <div className={styles.root} style={homepageRootStyle} data-homepage-root>
      <noscript>
        <style>{NOSCRIPT_CSS}</style>
      </noscript>
      <HomepageNav links={links} />
      <main id="main">
        <HeroSection links={links} />
        <StackSection />
        <NetworkSection />
        <IssuanceSection />
        <PaymentsSection />
        <div className={cn(styles.panel, styles.panelRun)}>
          <MarketsSection />
        </div>
        <InterfacesSection links={links} />
        <BuildersSection />
        <StartSection links={links} />
      </main>
      <HomepageFooter links={links} />
    </div>
  );
}
