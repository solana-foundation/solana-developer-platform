import Link from "next/link";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import buttons from "./buttons.module.css";
import { HeroGlobe } from "./hero-globe";
import { HeroLogoBar } from "./hero-logo-bar";
import styles from "./hero-section.module.css";
import { HeroStage } from "./hero-stage";
import { HeroTitle } from "./hero-title";
import homepage from "./homepage.module.css";
import type { NavLink } from "./homepage-links";
import { NavAnchor } from "./nav-anchor";

type HeroSectionProps = {
  t: (key: MessageKey) => string;
  docsHref: string;
  /** Account creation when signup is open, the waitlist otherwise; the same as the bar's. */
  primaryAction: NavLink;
};

/** The first screen: the statement and its two actions beside the globe, and the logo wall. */
export function HeroSection({ t, docsHref, primaryAction }: HeroSectionProps) {
  return (
    <HeroStage className={styles.hero}>
      <div className={cn(homepage.band, styles.stage)}>
        <div className={styles.words}>
          <HeroTitle />
          <p className={styles.lede}>{t("Homepage.hero.lede")}</p>
          <div className={styles.actions}>
            <Link href={docsHref} className={cn(buttons.button, buttons.line)}>
              {t("Homepage.hero.readDocs")}
            </Link>
            <NavAnchor link={primaryAction} className={cn(buttons.button, buttons.fill)}>
              {t(primaryAction.label)}
            </NavAnchor>
          </div>
        </div>
        <HeroGlobe />
      </div>
      <HeroLogoBar t={t} />
    </HeroStage>
  );
}
