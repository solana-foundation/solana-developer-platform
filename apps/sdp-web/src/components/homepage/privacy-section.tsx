import { cn } from "@sdp/ui/cn";
import { getTranslations } from "@/i18n/server";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { SECTION_LINKS } from "./homepage-links";
import { MoreLink } from "./more-link";
import styles from "./privacy/privacy.module.css";
import { PrivacyBubble } from "./privacy/privacy-bubble";
import { Rise } from "./rise";

/**
 * The privacy deep dive: the words beside a green bubble that folds into a switch and turns on. It
 * closes the dark panel it shares with markets.
 */
export async function PrivacySection() {
  const t = await getTranslations();

  return (
    <section id="privacy" data-ground="panel" className={styles.section}>
      <div className={cn(shared.wrap, styles.layout)}>
        <Rise index={0} className={styles.text}>
          <FormHeadline
            as="h2"
            className={styles.title}
            parts={[
              t("Homepage.privacy.titleLine1"),
              { lineBreak: true },
              t("Homepage.privacy.titleLine2"),
            ]}
          />
          <p className={styles.body}>{t("Homepage.privacy.body")}</p>
          <MoreLink href={SECTION_LINKS.policies}>{t("Homepage.privacy.policiesLink")}</MoreLink>
        </Rise>
        <Rise index={1} className={styles.vis}>
          <PrivacyBubble
            label={t("Homepage.privacy.bubbleLabel")}
            words={[
              t("Homepage.privacy.words.payments"),
              t("Homepage.privacy.words.issuance"),
              t("Homepage.privacy.words.markets"),
              t("Homepage.privacy.words.payroll"),
              t("Homepage.privacy.words.balances"),
            ]}
          />
        </Rise>
      </div>
    </section>
  );
}
