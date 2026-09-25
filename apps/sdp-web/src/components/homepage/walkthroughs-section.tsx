import type { MessageKey } from "@/i18n/messages";
import { FormHeading } from "./form-heading";
import homepage from "./homepage.module.css";
import { Rise } from "./rise";
import section from "./section.module.css";
import { WalkthroughsPlayer } from "./walkthroughs-player";

/** "The sandbox walkthroughs.": the films recorded from the console. */
export function WalkthroughsSection({ t }: { t: (key: MessageKey) => string }) {
  return (
    <section id="walkthroughs" data-ground="paper" className={section.section}>
      <div className={homepage.band}>
        <FormHeading className={section.title} lines={[t("Homepage.walkthroughs.title")]} />
        <Rise>
          <WalkthroughsPlayer />
        </Rise>
      </div>
    </section>
  );
}
