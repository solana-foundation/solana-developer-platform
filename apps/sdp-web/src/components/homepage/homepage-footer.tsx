import { SDP_GITHUB_REPO_URL } from "@sdp/types";
import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "@/i18n/server";
import { cn } from "@/lib/utils";
import shared from "./homepage.module.css";
import styles from "./homepage-footer.module.css";
import type { HomepageLinks } from "./homepage-links";

/** Who provides the platform, named in the footer's last line. */
const FOOTER_ORGANIZATION = "Solana Foundation";

type FooterLink = { label: string; href: string };
type FooterColumn = { id: string; title: string; links: FooterLink[] };

/**
 * The page's footer. It shares the close's night: the close's glass mark runs on down behind it,
 * so the footer's content sits above the mark (see the module).
 */
export async function HomepageFooter({ links }: { links: HomepageLinks }) {
  const t = await getTranslations();
  const columns: FooterColumn[] = [
    {
      id: "platform",
      title: t("Homepage.footer.columns.platform"),
      links: [
        { label: t("Homepage.footer.links.issuance"), href: "#issuance" },
        { label: t("Homepage.footer.links.payments"), href: "#payments" },
        { label: t("Homepage.footer.links.markets"), href: "#markets" },
        { label: t("Homepage.footer.links.privacy"), href: "#privacy" },
      ],
    },
    {
      id: "developers",
      title: t("Homepage.footer.columns.developers"),
      links: [
        { label: t("Homepage.footer.links.interfaces"), href: "#interfaces" },
        { label: t("Homepage.footer.links.docs"), href: links.docs },
        { label: t("Homepage.footer.links.openApi"), href: links.openapi },
        { label: t("Homepage.footer.links.github"), href: SDP_GITHUB_REPO_URL },
      ],
    },
    {
      id: "ecosystem",
      title: t("Homepage.footer.columns.ecosystem"),
      links: [
        { label: t("Homepage.footer.links.partners"), href: "#stack" },
        { label: t("Homepage.footer.links.builders"), href: "#builders" },
        { label: t("Homepage.footer.links.tutorials"), href: "#blog" },
      ],
    },
  ];

  return (
    <footer id="footer" data-ground="night" className={cn(shared.night, styles.footer)}>
      <div className={cn(shared.wrap, styles.inner)}>
        <div className={styles.grid}>
          <div className={styles.lead}>
            <Link className={styles.brand} href="/" aria-label={t("Homepage.footer.home")}>
              <Image src="/homepage/v6/logo-sdp-lockup-on-dark.svg" alt="" width={78} height={30} />
            </Link>
            <p className={styles.tagline}>{t("Homepage.footer.tagline")}</p>
          </div>
          {columns.map((column) => (
            <div key={column.id}>
              <h2 className={styles.columnTitle}>{column.title}</h2>
              <ul className={styles.list}>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a className={styles.link} href={link.href}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className={styles.bottom}>
          {t("Homepage.footer.providedBy", { organization: FOOTER_ORGANIZATION })}
        </p>
      </div>
    </footer>
  );
}
