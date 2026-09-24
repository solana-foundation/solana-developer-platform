"use client";

import Image from "next/image";
import { useState } from "react";
import { useTranslations } from "@/i18n/provider";
import styles from "./partner-marquee.module.css";
import { PauseButton } from "./pause-button";

/**
 * Partner names are proper nouns and stay untranslated. The logos are the design's app-icon
 * tiles, which carry their own grounds, so they read on paper and night alike.
 */
const PARTNERS = [
  { name: "Fireblocks", logo: "fireblocks" },
  { name: "Helius", logo: "helius" },
  { name: "Alchemy", logo: "alchemy" },
  { name: "Coinbase", logo: "coinbase-cdp" },
  { name: "BitGo", logo: "bitgo" },
  { name: "Anchorage", logo: "anchorage" },
  { name: "Turnkey", logo: "turnkey" },
  { name: "Privy", logo: "privy" },
  { name: "Para", logo: "para" },
  { name: "Dfns", logo: "dfns" },
  { name: "Utila", logo: "utila" },
  { name: "QuickNode", logo: "quicknode" },
  { name: "Triton", logo: "triton" },
  { name: "Nodit", logo: "nodit" },
  { name: "Validation Cloud", logo: "validation-cloud" },
  { name: "Chainalysis", logo: "chainalysis" },
  { name: "Elliptic", logo: "elliptic" },
  { name: "TRM Labs", logo: "trm-labs" },
  { name: "Range", logo: "range" },
  { name: "MoonPay", logo: "moonpay" },
  { name: "Stripe", logo: "stripe" },
  { name: "BVNK", logo: "bvnk" },
  { name: "MoneyGram", logo: "moneygram" },
  { name: "Lightspark", logo: "lightspark" },
  { name: "Mural", logo: "mural" },
  { name: "Kamino", logo: "kamino" },
  { name: "IBM", logo: "ibm-digital-asset-haven" },
] as const;

function PartnerList({ hidden }: { hidden?: boolean }) {
  return (
    <ul className={styles.list} aria-hidden={hidden || undefined}>
      {PARTNERS.map((partner) => (
        <li key={partner.name} className={styles.partner}>
          <Image
            src={`/homepage/partners/${partner.logo}.png`}
            alt=""
            width={24}
            height={24}
            // A few tiles are dark marks on transparency; on the dark theme they sit on a light chip.
            className="dark:bg-[#fcfcfa] dark:p-0.5"
          />
          {partner.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * The partners, passing along the floor of the statement. The list is drawn
 * twice so the loop has no seam; the copy is hidden from assistive technology.
 * Moving content needs a way to stop it (WCAG 2.2.2), so the strip has a
 * pause button; under reduced motion it does not move and wraps instead.
 */
export function PartnerMarquee() {
  const t = useTranslations();
  const [paused, setPaused] = useState(false);

  return (
    <section className={styles.marquee} aria-label={t("Homepage.stack.partners")}>
      <div className={styles.track} data-paused={paused}>
        <PartnerList />
        <PartnerList hidden />
      </div>
      <PauseButton
        paused={paused}
        onToggle={() => setPaused((value) => !value)}
        labels={{ pause: "Homepage.stack.pause", play: "Homepage.stack.play" }}
        className={styles.toggle}
      />
    </section>
  );
}
