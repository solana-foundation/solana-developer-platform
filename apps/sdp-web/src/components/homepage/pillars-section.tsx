import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { MoreLink } from "./more-link";
import { PillarBubble, type PillarBubbleKind } from "./pillars/pillar-bubble";
import styles from "./pillars/pillars.module.css";
import { Rise } from "./rise";

type PillarKey = "issuance" | "payments" | "markets";

/** Each pillar's picture and the section further down the page it leads to. */
const PILLARS: readonly { key: PillarKey; kind: PillarBubbleKind; href: string }[] = [
  { key: "issuance", kind: "coin", href: "#issuance" },
  { key: "payments", kind: "send", href: "#payments" },
  { key: "markets", kind: "swap", href: "#markets" },
];

export async function PillarsSection() {
  const t = await getTranslations();

  return (
    <section id="pillars" data-ground="paper" className={cn(shared.paper, styles.section)}>
      <div className={shared.wrap}>
        <Rise index={0} className={styles.head}>
          <div className={styles.headline}>
            <FormHeadline
              as="h2"
              className={shared.display}
              parts={[
                t("Homepage.pillars.headlineLine1"),
                { lineBreak: true },
                t("Homepage.pillars.headlineLine2"),
              ]}
            />
          </div>
          <p className={styles.intro}>{t("Homepage.pillars.intro")}</p>
        </Rise>

        <div className={styles.grid}>
          {PILLARS.map((pillar, order) => (
            <Rise key={pillar.key} index={order + 1} className={styles.pillar}>
              <PillarBubble
                kind={pillar.kind}
                order={order}
                label={t(`Homepage.pillars.${pillar.key}.imageLabel`)}
              />
              <h3 className={styles.title}>{t(`Homepage.pillars.${pillar.key}.title`)}</h3>
              <p className={styles.body}>{t(`Homepage.pillars.${pillar.key}.body`)}</p>
              <MoreLink href={pillar.href}>{t(`Homepage.pillars.${pillar.key}.link`)}</MoreLink>
            </Rise>
          ))}
        </div>
      </div>
    </section>
  );
}
