import { getRequestLocale, getTranslations } from "@/i18n/server";
import { formatNumber } from "@/lib/number-format";
import { cn } from "@/lib/utils";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { Rise } from "./rise";
import { PartnerMarquee } from "./stack/partner-marquee";
import styles from "./stack/stack.module.css";
import { StackDrawing, type StackDrawingCopy } from "./stack/stack-drawing";
import { RECEIVED_AMOUNTS } from "./stack/stack-timeline";

/** The statement: one integration across the stack, the route through SDP, and the partners under it. */
export async function StackSection() {
  const t = await getTranslations();
  const locale = await getRequestLocale();
  const copy: StackDrawingCopy = {
    labels: {
      partners: t("Homepage.stack.labels.partners"),
      sdp: t("Homepage.stack.labels.sdp"),
      product: t("Homepage.stack.labels.product"),
    },
    aria: {
      partners: t("Homepage.stack.aria.partners"),
      sdp: t("Homepage.stack.aria.sdp"),
      product: t("Homepage.stack.aria.product"),
    },
    services: {
      custody: t("Homepage.stack.services.custody"),
      compliance: t("Homepage.stack.services.compliance"),
      ramps: t("Homepage.stack.services.ramps"),
      nodes: t("Homepage.stack.services.nodes"),
      wallets: t("Homepage.stack.services.wallets"),
    },
    products: {
      wallet: t("Homepage.stack.products.wallet"),
      checkout: t("Homepage.stack.products.checkout"),
      payroll: t("Homepage.stack.products.payroll"),
      treasury: t("Homepage.stack.products.treasury"),
    },
    received: RECEIVED_AMOUNTS.map((amount) =>
      t("Homepage.stack.received", { amount: formatNumber(locale, amount, 2) })
    ),
  };

  return (
    <section id="stack" data-ground="paper" className={cn(shared.paper, styles.section)}>
      <div className={cn(shared.wrap, styles.inner)}>
        <Rise index={0} className={styles.head}>
          <FormHeadline as="h2" className={styles.title} parts={[t("Homepage.stack.title")]} />
          <p className={styles.sub}>{t("Homepage.stack.sub")}</p>
        </Rise>
        <Rise index={1}>
          <StackDrawing copy={copy} />
        </Rise>
      </div>
      <Rise index={2} className={styles.marquee}>
        <PartnerMarquee label={t("Homepage.stack.partnersLabel")} />
      </Rise>
    </section>
  );
}
