import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { SECTION_LINKS } from "./homepage-links";
import { MoreLink } from "./more-link";
import { PaymentBench } from "./payments/payment-bench";
import { PaymentBubble } from "./payments/payment-bubble";
import { PaymentKindProvider } from "./payments/payment-kind-context";
import styles from "./payments-section.module.css";
import { Rise } from "./rise";

/**
 * Payments: stablecoins and fiat through one API. The bubble shows the kind on the bench's
 * stage; the bench below walks through the six kinds, drawing each one's payment as it moves.
 */
export async function PaymentsSection() {
  const t = await getTranslations();

  return (
    <section id="payments" data-ground="paper" className={shared.paper}>
      <div className={cn(shared.wrap, styles.row)}>
        <Rise index={0} className={styles.text}>
          <FormHeadline
            as="h2"
            className={styles.title}
            parts={[
              t("Homepage.payments.titleLine1"),
              { lineBreak: true },
              t("Homepage.payments.titleLine2"),
            ]}
          />
          <p className={styles.body}>{t("Homepage.payments.body")}</p>
          <MoreLink href={SECTION_LINKS.payments}>{t("Homepage.payments.sandboxLink")}</MoreLink>
        </Rise>
        <PaymentKindProvider>
          <Rise index={1} className={styles.vis}>
            <PaymentBubble />
          </Rise>
          <Rise index={2} className={styles.bench}>
            <PaymentBench />
          </Rise>
        </PaymentKindProvider>
      </div>
    </section>
  );
}
