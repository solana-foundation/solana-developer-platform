import Image from "next/image";
import type { MessageKey } from "@/i18n/messages";
import styles from "./home-footer.module.css";
import homepage from "./homepage.module.css";
import type { HomepageHrefs, NavLink } from "./homepage-links";
import { NavAnchor } from "./nav-anchor";

type Column = { title: MessageKey; links: NavLink[] };

function columns(hrefs: HomepageHrefs): Column[] {
  return [
    {
      title: "Homepage.footer.platform",
      links: [
        { href: "#issuance", label: "Homepage.footer.links.issuance" },
        { href: "#payments", label: "Homepage.footer.links.payments" },
        { href: "#markets", label: "Homepage.footer.links.markets" },
        { href: "#privacy", label: "Homepage.footer.links.privacy" },
      ],
    },
    {
      title: "Homepage.footer.developers",
      links: [
        { href: "#interfaces", label: "Homepage.footer.links.interfaces" },
        { href: hrefs.docs, label: "Homepage.footer.links.docs" },
        { href: hrefs.openApi, label: "Homepage.footer.links.openApi", external: true },
        { href: hrefs.github, label: "Homepage.footer.links.github", external: true },
      ],
    },
    {
      title: "Homepage.footer.ecosystem",
      links: [
        { href: "#stack", label: "Homepage.footer.links.partners" },
        { href: "#builders", label: "Homepage.footer.links.builders" },
        { href: "#walkthroughs", label: "Homepage.footer.links.walkthroughs" },
      ],
    },
  ];
}

type HomeFooterProps = { t: (key: MessageKey) => string; hrefs: HomepageHrefs };

/** The page's foot, on night: the mark, the line, and three columns of links. */
export function HomeFooter({ t, hrefs }: HomeFooterProps) {
  return (
    <footer data-ground="night" className={styles.footer}>
      <div className={homepage.band}>
        <div className={styles.grid}>
          <div>
            <span className={styles.brand}>
              <Image
                src="/homepage/logos/sdp-mark.svg"
                alt=""
                width={19}
                height={17}
                className={styles.brandMark}
              />
              <b className={styles.brandWord}>{t("Homepage.nav.wordmark")}</b>
            </span>
            <p className={styles.tagline}>{t("Homepage.footer.tagline")}</p>
          </div>
          {columns(hrefs).map((column, index) => (
            <nav
              key={column.title}
              className={styles.column}
              aria-labelledby={`footer-column-${index}`}
            >
              <h2 id={`footer-column-${index}`}>{t(column.title)}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <NavAnchor link={link}>{t(link.label)}</NavAnchor>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className={styles.bottom}>{t("Homepage.footer.provided")}</p>
      </div>
    </footer>
  );
}
