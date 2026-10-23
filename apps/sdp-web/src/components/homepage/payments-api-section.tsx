import { cn } from "@sdp/ui/cn";
import { getTranslations } from "@/i18n/server";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { SECTION_LINKS } from "./homepage-links";
import { MoreLink } from "./more-link";
import { PaymentBubble } from "./payments/payment-bubble";
import styles from "./payments-api-section.module.css";
import { Rise } from "./rise";

/**
 * Stablecoins and fiat through one API, after the interfaces: the words beside the violet bubble,
 * which shows the kind on the bench's stage further up (the page's PaymentKindProvider).
 */
export async function PaymentsApiSection() {
  const t = await getTranslations();

  return (
    <section id="payments-api" data-ground="paper">
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
        <Rise index={1} className={styles.vis}>
          <PaymentBubble />
        </Rise>
      </div>
    </section>
  );
}
