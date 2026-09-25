import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { CountUp } from "./count-up";
import { FormHeading } from "./form-heading";
import homepage from "./homepage.module.css";
import styles from "./network-section.module.css";
import { Rise } from "./rise";
import { SpeedLanes } from "./speed-lanes";

/** The counted figures; their labels live in the catalog. */
const COUNTED = [
  { key: "partners", to: 30, suffix: "+" },
  { key: "fiat", to: 200, suffix: "+" },
  { key: "api", to: 1, suffix: "" },
] as const;

/** "Settled everywhere, under a second.": the network, its speed and its numbers, on night. */
export function NetworkSection({ t }: { t: (key: MessageKey) => string }) {
  return (
    <section id="network" data-ground="night" className={cn(homepage.night, styles.network)}>
      <div className={homepage.band}>
        <div className={styles.head}>
          <FormHeading
            className={styles.title}
            lines={[t("Homepage.network.titleFirst"), t("Homepage.network.titleSecond")]}
          />
          <p className={styles.body}>{t("Homepage.network.body")}</p>
        </div>
        <SpeedLanes mode="race" label="Homepage.network.speedLabel" />
        <Rise>
          <ul className={styles.stats}>
            <li className={styles.stat}>
              <b className={styles.value}>{t("Homepage.network.stats.finality.value")}</b>
              <span className={styles.label}>{t("Homepage.network.stats.finality.label")}</span>
            </li>
            {COUNTED.map(({ key, to, suffix }) => (
              <li key={key} className={styles.stat}>
                <b className={styles.value}>
                  <CountUp to={to} suffix={suffix} />
                </b>
                <span className={styles.label}>{t(`Homepage.network.stats.${key}.label`)}</span>
              </li>
            ))}
          </ul>
        </Rise>
      </div>
    </section>
  );
}
