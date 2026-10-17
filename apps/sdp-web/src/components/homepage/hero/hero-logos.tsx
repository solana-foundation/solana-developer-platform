import Image from "next/image";
import styles from "./hero.module.css";

type Logo = { name: string; src: string; width: number; height: number };

/* each mark at its own set height, its width from the SVG's own proportions */
export const SDP_BUILDERS: readonly Logo[] = [
  { name: "Mastercard", src: "/homepage/logos/mastercard.svg", width: 142, height: 29 },
  { name: "Western Union", src: "/homepage/logos/westernunion-b.svg", width: 191, height: 22 },
  { name: "Worldpay", src: "/homepage/logos/worldpay.svg", width: 89, height: 20 },
];

export const SOLANA_BUILDERS: readonly Logo[] = [
  { name: "PayPal", src: "/homepage/logos/paypal.svg", width: 73, height: 25 },
  { name: "Visa", src: "/homepage/logos/visa.svg", width: 55, height: 18 },
  { name: "DTCC", src: "/homepage/logos/dtcc.svg", width: 76, height: 17 },
  { name: "State Street", src: "/homepage/logos/statestreet.svg", width: 87, height: 24 },
];

function LogoBlock({ label, logos }: { label: string; logos: readonly Logo[] }) {
  return (
    <li className={styles.logocell}>
      <p className={styles.logoLabel}>{label}</p>
      <ul className={styles.logoRow}>
        {logos.map((logo) => (
          <li key={logo.name}>
            <Image
              className={styles.logo}
              src={logo.src}
              alt={logo.name}
              width={logo.width}
              height={logo.height}
              unoptimized
              style={{ height: logo.height }}
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The logo wall along the hero's floor: who builds with SDP, and who builds on Solana. */
export function HeroLogos({
  withSdpLabel,
  onSolanaLabel,
}: {
  withSdpLabel: string;
  onSolanaLabel: string;
}) {
  return (
    <ul className={styles.logobar}>
      <LogoBlock label={withSdpLabel} logos={SDP_BUILDERS} />
      <LogoBlock label={onSolanaLabel} logos={SOLANA_BUILDERS} />
    </ul>
  );
}
