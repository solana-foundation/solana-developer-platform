import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import type { HomepageLinks } from "./homepage-links";
import { Rise } from "./rise";
import { LoopGate } from "./start/loop-gate";
import styles from "./start/start.module.css";
import { StartDoor } from "./start/start-door";
import { StartMark } from "./start/start-mark";

/** The close: the last headline, the glass Solana mark, and the sign-up door across the page. */
export async function StartSection({ links }: { links: HomepageLinks }) {
  const t = await getTranslations();

  return (
    <LoopGate id="start" data-ground="night" className={cn(shared.night, styles.section)}>
      <StartMark className={styles.mark} />
      <div className={cn(shared.wrap, styles.inner)}>
        <Rise index={0} className={styles.text}>
          <FormHeadline
            as="h2"
            className={styles.title}
            parts={[
              t("Homepage.start.titleBefore"),
              { text: t("Homepage.start.titleHighlight"), className: styles.pill },
              t("Homepage.start.titleAfter"),
            ]}
          />
          <p className={styles.sub}>{t("Homepage.start.sub")}</p>
        </Rise>
        <Rise index={1} className={styles.doorRise}>
          {/* the note promises devnet keys, which the waitlist cannot give */}
          <StartDoor
            signup={{ ...links.signup, label: t("Homepage.start.openSandbox") }}
            note={
              links.signup.external || links.signedIn ? undefined : t("Homepage.start.doorNote")
            }
          />
        </Rise>
      </div>
    </LoopGate>
  );
}
