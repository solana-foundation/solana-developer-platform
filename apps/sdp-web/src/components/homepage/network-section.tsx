import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { CountUp } from "./network/count-up";
import styles from "./network/network.module.css";
import { SpeedRace } from "./network/speed-race";
import { Rise } from "./rise";

/** The figures under the race; `count` marks the ones that count up, into the catalog's `{count}`. */
const STATS = [
  { key: "finality" },
  { key: "partners", count: 30 },
  { key: "currencies", count: 200 },
  { key: "contract", count: 1 },
] as const satisfies readonly { key: string; count?: number }[];

/** "Settled everywhere, under a second.": the speed race and the figures behind it. */
export async function NetworkSection() {
  const t = await getTranslations();

  return (
    <section id="network" data-ground="paper" className={cn(shared.paper, styles.section)}>
      <div className={shared.wrap}>
        <Rise index={0} className={styles.head}>
          <FormHeadline
            as="h2"
            className={cn(shared.display, styles.headline)}
            parts={[
              t("Homepage.network.headlineLine1"),
              { lineBreak: true },
              { text: t("Homepage.network.headlineHighlight"), className: styles.selN },
              t("Homepage.network.headlineEnd"),
            ]}
          />
          <p className={styles.intro}>{t("Homepage.network.intro")}</p>
        </Rise>
        <Rise index={1}>
          <SpeedRace />
        </Rise>
        <Rise index={2} className={styles.statsBlock}>
          <ul className={styles.stats}>
            {STATS.map((stat) => {
              return (
                <li key={stat.key} className={styles.stat}>
                  <b>
                    {"count" in stat ? (
                      <CountUp
                        to={stat.count}
                        message={`Homepage.network.stats.${stat.key}.value`}
                      />
                    ) : (
                      t(`Homepage.network.stats.${stat.key}.value`)
                    )}
                  </b>
                  <span>{t(`Homepage.network.stats.${stat.key}.label`)}</span>
                </li>
              );
            })}
          </ul>
        </Rise>
      </div>
    </section>
  );
}
