import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { Rise } from "./rise";
import styles from "./walkthroughs/walkthroughs.module.css";
import { WalkthroughsPlayer } from "./walkthroughs/walkthroughs-player";

export async function WalkthroughsSection() {
  const t = await getTranslations();

  return (
    <section id="blog" data-ground="night" className={cn(shared.night, styles.section)}>
      <div className={shared.wrap}>
        <Rise index={0}>
          <FormHeadline
            as="h2"
            className={shared.display}
            parts={[t("Homepage.walkthroughs.headline")]}
          />
        </Rise>
        <Rise index={1} className={styles.playerBlock}>
          <WalkthroughsPlayer />
        </Rise>
      </div>
    </section>
  );
}
