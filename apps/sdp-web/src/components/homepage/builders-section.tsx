import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import styles from "./builders/builders.module.css";
import { BuildersStage } from "./builders/builders-stage";
import shared from "./homepage.module.css";

/** Meet the builders: the sixteen films on a ring that turns with the scroll. */
export async function BuildersSection() {
  const t = await getTranslations();
  return (
    <section
      id="builders"
      data-ground="night"
      aria-label={t("Homepage.builders.label")}
      className={cn(shared.night, styles.section)}
    >
      <BuildersStage />
    </section>
  );
}
