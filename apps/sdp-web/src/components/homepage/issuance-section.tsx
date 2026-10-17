import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { SECTION_LINKS } from "./homepage-links";
import styles from "./issuance-section.module.css";
import { IssuanceSheet } from "./issuance-sheet";
import { MoreLink } from "./more-link";
import { Rise } from "./rise";

/** The issuance deep dive: the words beside an example asset sheet that runs through its lifecycle. */
export async function IssuanceSection() {
  const t = await getTranslations();

  return (
    <section id="issuance" data-ground="paper" className={shared.paper}>
      <div className={cn(shared.wrap, styles.layout)}>
        <Rise index={0}>
          <FormHeadline
            as="h2"
            className={styles.title}
            parts={[
              t("Homepage.issuance.titleLine1"),
              { lineBreak: true },
              t("Homepage.issuance.titleLine2"),
            ]}
          />
          <p className={styles.body}>{t("Homepage.issuance.body")}</p>
          <MoreLink href={SECTION_LINKS.issuance}>{t("Homepage.issuance.sandboxLink")}</MoreLink>
        </Rise>
        <Rise index={1} className={styles.vis}>
          <IssuanceSheet />
        </Rise>
      </div>
    </section>
  );
}
