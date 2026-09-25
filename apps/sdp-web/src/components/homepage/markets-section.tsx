import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import type { NavLink } from "./homepage-links";
import styles from "./markets-section.module.css";
import { ProductRow } from "./product-row";

const FLOOR = "M40 176 C 200 176, 300 174, 380 160 S 500 140, 540 132";
const CEILING = "M40 176 C 190 176, 300 170, 380 156 S 500 60, 540 34";
const BAND =
  "M40 176 C 190 176, 300 170, 380 156 S 500 60, 540 34 L540 132 C 500 138, 400 150, 380 152 S 200 176, 40 176 Z";

const STATS = ["yield", "withdraw"] as const;

type SectionProps = { t: (key: MessageKey) => string; sandbox: NavLink };

/** "Earn on it. Settle against it.": two strategies on one balance, drawn as they arrive. */
export function MarketsSection({ t, sandbox }: SectionProps) {
  return (
    <ProductRow
      id="markets"
      title={[t("Homepage.markets.titleFirst"), t("Homepage.markets.titleSecond")]}
      body={t("Homepage.markets.body")}
      more={{ link: sandbox, label: t("Homepage.markets.more") }}
      aside={
        <dl className={styles.stats}>
          {STATS.map((stat) => (
            <div key={stat} className={styles.stat}>
              <dt>{t(`Homepage.markets.stats.${stat}.value`)}</dt>
              <dd>{t(`Homepage.markets.stats.${stat}.label`)}</dd>
            </div>
          ))}
        </dl>
      }
    >
      <figure className="m-0">
        <svg
          className={styles.chart}
          viewBox="36 8 508 212"
          role="img"
          aria-label={t("Homepage.markets.chartLabel")}
        >
          <defs>
            <linearGradient id="markets-band" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#9945ff" stopOpacity=".14" />
              <stop offset="1" stopColor="#9945ff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="markets-floor" x1="0" x2="1">
              <stop offset="0" stopColor="#c9c6d1" />
              <stop offset=".55" stopColor="#8c8895" />
              <stop offset="1" className={styles.silverEnd} />
            </linearGradient>
            <linearGradient id="markets-ceiling" x1="0" x2="1">
              <stop offset="0" stopColor="#c9c6d1" />
              <stop offset=".45" stopColor="#9945ff" />
              <stop offset="1" stopColor="#dc1fff" />
            </linearGradient>
          </defs>
          <path className={styles.band} d={BAND} fill="url(#markets-band)" />
          <path className={styles.axisLine} d="M40 206H540" strokeWidth="1" />
          <path
            className={styles.curve}
            d={FLOOR}
            fill="none"
            stroke="url(#markets-floor)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            className={cn(styles.curve, styles.ceiling)}
            d={CEILING}
            fill="none"
            stroke="url(#markets-ceiling)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path className={styles.marker} d="M380 206V148" />
          <circle className={styles.floorDot} cx="540" cy="132" r="3.5" />
          <circle className={styles.pulse} cx="540" cy="34" r="4" />
        </svg>
        <div className={styles.axis} aria-hidden="true">
          <span>{t("Homepage.markets.axis.idle")}</span>
          <span className={styles.axisMiddle}>{t("Homepage.markets.axis.deployed")}</span>
          <span>{t("Homepage.markets.axis.today")}</span>
        </div>
        <ul className={styles.legend}>
          <li>
            <i className={cn(styles.key, styles.keyCeiling)} aria-hidden="true" />
            {t("Homepage.markets.legend.defi")}
          </li>
          <li>
            <i className={cn(styles.key, styles.keyFloor)} aria-hidden="true" />
            {t("Homepage.markets.legend.treasuries")}
          </li>
        </ul>
      </figure>
    </ProductRow>
  );
}
