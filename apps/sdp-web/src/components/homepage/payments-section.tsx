import { cn } from "@sdp/ui/cn";
import shared from "./homepage.module.css";
import { PaymentBench } from "./payments/payment-bench";
import styles from "./payments-section.module.css";
import { Rise } from "./rise";

/**
 * Payments: the bench under issuance walks through the six kinds, drawing each one's payment as it
 * moves. Its words and bubble are the payments API section further down the page; the bench moves
 * that bubble through the page's PaymentKindProvider.
 */
export function PaymentsSection() {
  return (
    <section id="payments" data-ground="paper" className={shared.paper}>
      <div className={cn(shared.wrap, styles.row)}>
        <Rise index={0}>
          <PaymentBench />
        </Rise>
      </div>
    </section>
  );
}
