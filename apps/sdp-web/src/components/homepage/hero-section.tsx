import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { HeroGlobe } from "./hero/globe/hero-globe";
import styles from "./hero/hero.module.css";
import { HeroGlide } from "./hero/hero-glide";
import { HeroHeadline } from "./hero/hero-headline";
import { HeroLogos } from "./hero/hero-logos";
import shared from "./homepage.module.css";
import { externalLinkProps, type HomepageLinks } from "./homepage-links";

/**
 * The first screen: the statement beside the network itself. The globe is the brand's device; a
 * payment crosses it every few seconds and its two tags say what left and that it landed.
 */
export async function HeroSection({ links }: { links: HomepageLinks }) {
  const t = await getTranslations();

  return (
    <header id="top" data-ground="paper" className={cn(shared.paper, styles.hero)}>
      <div className={cn(shared.wrap, styles.inner)}>
        <div className={styles.words}>
          <HeroHeadline
            lead={t("Homepage.hero.title.lead")}
            selected={t("Homepage.hero.title.selected")}
            secondLead={t("Homepage.hero.title.secondLead")}
            chosen={t("Homepage.hero.title.chosen")}
          />
          <p className={styles.lede}>{t("Homepage.hero.lede")}</p>
          <div className={styles.cta}>
            <a
              className={cn(shared.btn, shared.btnFill, shared.btnLg)}
              href={links.signup.href}
              {...externalLinkProps(links.signup.external)}
            >
              {links.signup.label}
            </a>
            <a className={cn(shared.btn, shared.btnLine, shared.btnLg)} href={links.docs}>
              {t("Homepage.cta.readDocs")}
            </a>
          </div>
        </div>
        <HeroGlobe className={styles.globe} />
      </div>
      <HeroLogos
        withSdpLabel={t("Homepage.hero.logos.withSdp")}
        onSolanaLabel={t("Homepage.hero.logos.onSolana")}
      />
      <HeroGlide heroId="top" nextId="stack" />
    </header>
  );
}
