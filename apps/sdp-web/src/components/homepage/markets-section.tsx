import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { SECTION_LINKS } from "./homepage-links";
import styles from "./markets/markets.module.css";
import { MarketsChart } from "./markets/markets-chart";
import { MoreLink } from "./more-link";
import { Rise } from "./rise";

/**
 * Markets: the headline with its paragraph and sandbox link, then the yield chart across the whole
 * width. The chart is the section's first block (it arrives first), the words the second, but the
 * words come first in the document so they are read first.
 */
export async function MarketsSection() {
  const t = await getTranslations();

  return (
    <section id="markets" data-ground="paper" className={cn(shared.paper, styles.section)}>
      <div className={cn(shared.wrap, styles.layout)}>
        <Rise index={1} className={styles.head}>
          <FormHeadline
            as="h2"
            className={styles.title}
            parts={[
              t("Homepage.markets.titleLine1"),
              { lineBreak: true },
              t("Homepage.markets.titleLine2"),
            ]}
          />
          <p className={styles.body}>{t("Homepage.markets.body")}</p>
          <MoreLink href={SECTION_LINKS.markets} className={styles.link}>
            {t("Homepage.markets.sandboxLink")}
          </MoreLink>
        </Rise>
        <Rise index={0} className={styles.chartBlock}>
          <MarketsChart />
        </Rise>
      </div>
    </section>
  );
}
