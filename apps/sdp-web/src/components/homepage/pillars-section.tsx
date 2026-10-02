import type { MessageKey } from "@/i18n/messages";
import { FormHeading } from "./form-heading";
import homepage from "./homepage.module.css";
import { MoreLink } from "./more-link";
import { Pillar } from "./pillar";
import styles from "./pillars-section.module.css";
import { Rise } from "./rise";
import type { OrigamiKind } from "./scenes/origami/builds";
import section from "./section.module.css";

type PillarKey = "issuance" | "payments" | "markets";

/** Each pillar's scene and camera distance, as the design pairs them. */
const PILLARS: { key: PillarKey; scene: { kind: OrigamiKind; zoom: number } }[] = [
  { key: "issuance", scene: { kind: "coins", zoom: 8.2 } },
  { key: "payments", scene: { kind: "loop", zoom: 7.6 } },
  { key: "markets", scene: { kind: "balance", zoom: 8.4 } },
];

/** "Issue it. Move it. Earn on it.": the three products, each a scene, a name and a line. */
export function PillarsSection({ t }: { t: (key: MessageKey) => string }) {
  return (
    <section id="pillars" data-ground="paper" className={section.section}>
      <div className={homepage.band}>
        <Rise className={section.head}>
          <FormHeading
            className={section.title}
            lines={[t("Homepage.pillars.titleFirst"), t("Homepage.pillars.titleSecond")]}
          />
          <p className={section.lede}>{t("Homepage.pillars.sub")}</p>
        </Rise>
        <Rise>
          <ul className={styles.pillars}>
            {PILLARS.map(({ key, scene }) => (
              <Pillar key={key} scene={scene}>
                <h3 className={styles.name}>{t(`Homepage.pillars.${key}.title`)}</h3>
                <p className={styles.body}>{t(`Homepage.pillars.${key}.body`)}</p>
                <MoreLink link={{ href: `#${key}` }} icon="arrow">
                  {t(`Homepage.pillars.${key}.more`)}
                </MoreLink>
              </Pillar>
            ))}
          </ul>
        </Rise>
      </div>
    </section>
  );
}
