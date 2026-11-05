import { cn } from "@sdp/ui/cn";
import { getTranslations } from "@/i18n/server";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import type { HomepageLinks } from "./homepage-links";
import styles from "./interfaces/interfaces.module.css";
import { InterfacesConsole } from "./interfaces/interfaces-console";
import { MoreLink } from "./more-link";
import { Rise } from "./rise";

type ReferenceKey = "openapi" | "llms" | "docs";

/** The reference links under the modes: the same targets the nav's Docs menu uses. */
function referenceLinks(links: HomepageLinks): { key: ReferenceKey; href: string }[] {
  return [
    { key: "openapi", href: links.openapi },
    { key: "llms", href: links.llms },
    { key: "docs", href: links.docs },
  ];
}

export async function InterfacesSection({ links }: { links: HomepageLinks }) {
  const t = await getTranslations();

  return (
    <section id="interfaces" data-ground="paper" className={cn(shared.paper, styles.section)}>
      <div className={shared.wrap}>
        <Rise index={0} className={styles.sechead}>
          <div className={styles.headline}>
            <FormHeadline
              as="h2"
              className={shared.display}
              parts={[t("Homepage.interfaces.headline")]}
            />
          </div>
          <p className={styles.intro}>{t("Homepage.interfaces.intro")}</p>
        </Rise>

        <InterfacesConsole
          modesLabel={t("Homepage.interfaces.modes")}
          responseLabel={t("Homepage.interfaces.response")}
          copy={{
            api: {
              title: t("Homepage.interfaces.api.title"),
              body: t("Homepage.interfaces.api.body"),
              status: t("Homepage.interfaces.api.status"),
            },
            dashboard: {
              title: t("Homepage.interfaces.dashboard.title"),
              body: t("Homepage.interfaces.dashboard.body"),
              status: t("Homepage.interfaces.dashboard.status"),
            },
          }}
          links={referenceLinks(links).map((link) => (
            <MoreLink key={link.key} href={link.href}>
              {t(`Homepage.interfaces.links.${link.key}`)}
            </MoreLink>
          ))}
        />
      </div>
    </section>
  );
}
