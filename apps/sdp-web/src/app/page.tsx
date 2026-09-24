import { auth } from "@clerk/nextjs/server";
import { BuildersSection } from "@/components/homepage/builders-section";
import { DoorSection } from "@/components/homepage/door-section";
import { HeroSection } from "@/components/homepage/hero-section";
import { HomeFooter } from "@/components/homepage/home-footer";
import { HomeNav } from "@/components/homepage/home-nav";
import {
  homepagePrimaryAction,
  navGroups,
  resolveHomepageHrefs,
} from "@/components/homepage/homepage-links";
import { HomepageRoot } from "@/components/homepage/homepage-root";
import { InterfacesSection } from "@/components/homepage/interfaces-section";
import { IssuanceSection } from "@/components/homepage/issuance-section";
import { MarketsSection } from "@/components/homepage/markets-section";
import { NetworkSection } from "@/components/homepage/network-section";
import { PaymentsSection } from "@/components/homepage/payments-section";
import { PillarsSection } from "@/components/homepage/pillars-section";
import { PrivacySection } from "@/components/homepage/privacy-section";
import { StackSection } from "@/components/homepage/stack-section";
import { WalkthroughsSection } from "@/components/homepage/walkthroughs-section";
import { homepageOpenSignup } from "@/flags";
import { getTranslations } from "@/i18n/server";

const hrefs = resolveHomepageHrefs();

export default async function Home() {
  const [t, openSignup, { userId }] = await Promise.all([
    getTranslations(),
    homepageOpenSignup(),
    auth(),
  ]);
  const signedIn = userId !== null;
  // The dashboard, the account or the waitlist: also where every "in the sandbox" link leads.
  const primaryAction = homepagePrimaryAction({ openSignup, signedIn });
  const groups = navGroups(hrefs, primaryAction);

  return (
    <HomepageRoot>
      <HomeNav groups={groups} primaryAction={primaryAction} signedIn={signedIn} />
      <main>
        <HeroSection t={t} docsHref={hrefs.docs} primaryAction={primaryAction} />
        <StackSection t={t} />
        <PillarsSection t={t} />
        <NetworkSection t={t} />
        <IssuanceSection t={t} sandbox={primaryAction} />
        <PaymentsSection t={t} sandbox={primaryAction} />
        <MarketsSection t={t} sandbox={primaryAction} />
        <PrivacySection t={t} sandbox={primaryAction} />
        <InterfacesSection t={t} hrefs={hrefs} />
        <BuildersSection />
        <WalkthroughsSection t={t} />
        <DoorSection t={t} sandbox={primaryAction} />
      </main>
      <HomeFooter t={t} hrefs={hrefs} />
    </HomepageRoot>
  );
}
