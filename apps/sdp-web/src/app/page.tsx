import { auth } from "@clerk/nextjs/server";
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
import { PillarsSection } from "@/components/homepage/pillars-section";
import { PrivacySection } from "@/components/homepage/privacy-section";
import { StackSection } from "@/components/homepage/stack-section";
import { StartSection } from "@/components/homepage/start-section";
import { WalkthroughsSection } from "@/components/homepage/walkthroughs-section";
import { homepageOpenSignup } from "@/flags";
import { getTranslations } from "@/i18n/server";

/*
 * Without script the page must still read: the blocks that rise in (`data-rise`), the letters that
 * form in (`data-form-letter`) and the captions shown by a scene (`data-noscript-reveal`) wait on
 * client effects, so a noscript style sets them in their final state. Stable data attributes,
 * since the CSS modules' class names are hashed. With script it never applies.
 */
const NOSCRIPT_CSS = [
  "[data-rise]{opacity:1!important;transform:none!important;clip-path:none!important}",
  "[data-form-letter]{color:inherit!important;-webkit-text-stroke:0!important;filter:none!important;opacity:1!important;transform:none!important}",
  "[data-noscript-reveal],[data-noscript-reveal] *{opacity:1!important;visibility:visible!important}",
  "[data-noscript-reveal] a{pointer-events:auto!important}",
].join("");

export default async function Home() {
  const [t, openSignup, { userId }] = await Promise.all([
    getTranslations(),
    homepageOpenSignup(),
    auth(),
  ]);
  const links = resolveHomepageLinks({
    signedIn: Boolean(userId),
    openSignup,
    createAccountLabel: t("Homepage.cta.createAccount"),
    joinWaitlistLabel: t("Homepage.cta.joinWaitlist"),
    dashboardLabel: t("Homepage.cta.dashboard"),
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
        <PillarsSection />
        <NetworkSection />
        <IssuanceSection />
        <PaymentsSection />
        <MarketsSection />
        <PrivacySection />
        <InterfacesSection links={links} />
        <BuildersSection />
        <WalkthroughsSection />
        <StartSection links={links} />
      </main>
      <HomepageFooter links={links} />
    </div>
  );
}
