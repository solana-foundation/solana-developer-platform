"use client";

import { useInView } from "motion/react";
import Image from "next/image";
import { useRef } from "react";
import { STACK_PARTNERS } from "./partners";
import styles from "./stack.module.css";

function PartnerList({ label, hidden }: { label?: string; hidden?: boolean }) {
  return (
    <ul className={styles.partnerList} aria-label={label} aria-hidden={hidden || undefined}>
      {STACK_PARTNERS.map((partner) => (
        <li key={partner.name} className={styles.partner}>
          {/* the name is set beside the mark, so the mark itself says nothing */}
          <Image className={styles.partnerLogo} src={partner.logo} alt="" width={24} height={24} />
          {partner.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * The partners' names passing along the floor of the stack. The list runs twice so the loop is
 * seamless; screen readers get it once. It holds still while off screen.
 */
export function PartnerMarquee({ label }: { label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useInView(ref);

  return (
    <div ref={ref} className={styles.marqueeTrack} data-paused={onScreen ? undefined : ""}>
      <PartnerList label={label} />
      <PartnerList hidden />
    </div>
  );
}
