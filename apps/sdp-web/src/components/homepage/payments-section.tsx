import { cn } from "@sdp/ui/cn";
import shared from "./homepage.module.css";
import type { PaymentKind } from "./payments/kinds";
import { PaymentBench } from "./payments/payment-bench";
import styles from "./payments-section.module.css";
import { isComingSoon } from "./release-gate";
import { Rise } from "./rise";

/**
 * Payments: the bench under issuance walks through the six kinds, drawing each one's payment as it
 * moves. Its words and bubble are the payments API section further down the page; the bench moves
 * that bubble through the page's PaymentKindProvider. Deposit tops up through a ramp, so it is
 * held back with ramps. No module ships Micro yet, so it is coming soon on every channel.
 */
export function PaymentsSection() {
  const comingSoonKinds: PaymentKind[] = isComingSoon("ramps") ? ["micro", "deposit"] : ["micro"];

  return (
    <section id="payments" data-ground="paper" className={shared.paper}>
      <div className={cn(shared.wrap, styles.row)}>
        <Rise index={0}>
          <PaymentBench comingSoonKinds={comingSoonKinds} />
        </Rise>
      </div>
    </section>
  );
}
