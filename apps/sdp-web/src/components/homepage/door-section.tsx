import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import styles from "./door-section.module.css";
import { ExternalIcon } from "./external-icon";
import homepage from "./homepage.module.css";
import type { NavLink } from "./homepage-links";
import { NavAnchor } from "./nav-anchor";
import { Rise } from "./rise";

type DoorSectionProps = { t: (key: MessageKey) => string; sandbox: NavLink };

/** "Open the sandbox": the way in, as one big button. */
export function DoorSection({ t, sandbox }: DoorSectionProps) {
  return (
    <section id="start" data-ground="night" className={cn(homepage.night, styles.door)}>
      <div className={homepage.band}>
        <Rise>
          <NavAnchor link={sandbox} className={styles.link}>
            <span className={styles.words}>
              <b className="font-normal">{t("Homepage.door.title")}</b>
              <small>{t("Homepage.door.body")}</small>
            </span>
            <ExternalIcon className={styles.icon} />
          </NavAnchor>
        </Rise>
      </div>
    </section>
  );
}
