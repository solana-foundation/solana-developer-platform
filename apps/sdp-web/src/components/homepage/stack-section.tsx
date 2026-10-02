import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { FormHeading } from "./form-heading";
import homepage from "./homepage.module.css";
import { PartnerMarquee } from "./partner-marquee";
import { Rise } from "./rise";
import styles from "./stack-section.module.css";

/** "One integration across the stack": the aggregation statement, and the partners under it. */
export function StackSection({ t }: { t: (key: MessageKey) => string }) {
  return (
    <section id="stack" data-ground="paper" className={styles.stack}>
      <div className={cn(homepage.band, styles.statement)}>
        <FormHeading
          className={styles.title}
          lines={[t("Homepage.stack.titleFirst"), t("Homepage.stack.titleSecond")]}
        />
        <Rise>
          <p className={styles.sub}>{t("Homepage.stack.sub")}</p>
        </Rise>
        <Rise>
          <p className={styles.flow}>
            <span className="sr-only">{t("Homepage.stack.flow")}</span>
            <b aria-hidden="true">{t("Homepage.stack.flowPartners")}</b>
            <span aria-hidden="true">→</span>
            <b aria-hidden="true">{t("Homepage.stack.flowSdp")}</b>
            <span aria-hidden="true">→</span>
            <span aria-hidden="true" className={styles.product}>
              {t("Homepage.stack.flowProduct")}
            </span>
          </p>
        </Rise>
      </div>
      <PartnerMarquee />
    </section>
  );
}
