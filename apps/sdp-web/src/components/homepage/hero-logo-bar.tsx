import Image from "next/image";
import type { MessageKey } from "@/i18n/messages";
import styles from "./hero-logo-bar.module.css";

type Logo = { src: string; name: MessageKey; width: number; height: number };

/** Heights are the design's; widths follow each file's aspect ratio. */
const WITH_SDP: Logo[] = [
  { src: "mastercard", name: "Homepage.hero.logos.mastercard", width: 108, height: 22 },
  { src: "westernunion", name: "Homepage.hero.logos.westernUnion", width: 148, height: 17 },
  { src: "worldpay", name: "Homepage.hero.logos.worldpay", width: 67, height: 15 },
];

const ON_SOLANA: Logo[] = [
  { src: "paypal", name: "Homepage.hero.logos.paypal", width: 55, height: 19 },
  { src: "visa", name: "Homepage.hero.logos.visa", width: 43, height: 14 },
  { src: "dtcc", name: "Homepage.hero.logos.dtcc", width: 58, height: 13 },
  { src: "statestreet", name: "Homepage.hero.logos.stateStreet", width: 65, height: 18 },
];

type Translate = (key: MessageKey) => string;

function LogoCell({ label, logos, t }: { label: MessageKey; logos: Logo[]; t: Translate }) {
  return (
    <li className={styles.cell}>
      <span className={styles.label}>{t(label)}</span>
      <ul className={styles.logos}>
        {logos.map((logo) => (
          <li key={logo.src}>
            <Image
              src={`/homepage/logos/${logo.src}.svg`}
              alt={t(logo.name)}
              width={logo.width}
              height={logo.height}
              style={{ height: logo.height }}
              className="dark:invert"
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

export function HeroLogoBar({ t }: { t: Translate }) {
  return (
    <ul className={styles.bar}>
      <LogoCell label="Homepage.hero.buildingWithSdp" logos={WITH_SDP} t={t} />
      <LogoCell label="Homepage.hero.buildingOnSolana" logos={ON_SOLANA} t={t} />
    </ul>
  );
}
