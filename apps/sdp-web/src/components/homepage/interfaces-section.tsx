import { DEFAULT_SDP_API_URL } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { FormHeading } from "./form-heading";
import cells from "./hairline-cells.module.css";
import homepage from "./homepage.module.css";
import type { HomepageHrefs } from "./homepage-links";
import styles from "./interfaces-section.module.css";
import { NavAnchor } from "./nav-anchor";
import { Rise } from "./rise";
import section from "./section.module.css";

/** A real call against the public contract: POST /v1/payments/transfers (createPaymentTransfer). */
const REQUEST = [
  `curl -X POST ${DEFAULT_SDP_API_URL}/v1/payments/transfers \\`,
  '    -H "Authorization: Bearer sk_test_…" \\',
  '    -H "Idempotency-Key: 5f0c…" \\',
  `    -d '{ \\\n      "sourceCustodyWalletId":"cwlt_…", "destination":"7xKX…", \\\n      "token":"USDC", "amount":"24800" \\\n    }'`,
].join("\n");
const RESPONSE_OPEN = '{\n  "transfer": {\n    "id": "xfr_9f2c",\n    "status": ';
const RESPONSE_STATUS = '"confirmed"';
const RESPONSE_CLOSE = "\n  }\n}\n";

/** The three ways to use SDP, with the design's line icons. */
const MODES = [
  { key: "execute", icon: <path d="M20 4 11 13M20 4l-6.5 17-3-7.5L3 10z" /> },
  {
    key: "prepare",
    icon: (
      <>
        <circle cx="7.5" cy="15.5" r="5.5" />
        <path d="m21 2-9.9 9.9M15.5 7.5l3.5 3.5L22 8l-3.5-3.5Z" />
      </>
    ),
  },
  {
    key: "dashboard",
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
  },
] as const;

type InterfacesSectionProps = {
  t: (key: MessageKey) => string;
  hrefs: HomepageHrefs;
};

/** "Call the API. Or use the dashboard.": a call and its answer, the three modes, the references. */
export function InterfacesSection({ t, hrefs }: InterfacesSectionProps) {
  return (
    <section id="interfaces" data-ground="night" className={cn(homepage.night, styles.interfaces)}>
      <div className={homepage.band}>
        <Rise className={section.head}>
          <FormHeading
            className={styles.title}
            lines={[t("Homepage.interfaces.titleFirst"), t("Homepage.interfaces.titleSecond")]}
          />
          <p className={styles.lede}>{t("Homepage.interfaces.body")}</p>
        </Rise>
        <Rise className={styles.grid}>
          <figure className={styles.request}>
            <figcaption className="sr-only">{t("Homepage.interfaces.codeLabel")}</figcaption>
            <pre className={styles.code}>
              <span className={styles.prompt}>$ </span>
              {REQUEST}
              {"\n"}
              {RESPONSE_OPEN}
              <span className={styles.ok}>{RESPONSE_STATUS}</span>
              {RESPONSE_CLOSE}
              <span className={styles.prompt}>$ </span>
              <span className={styles.cursor} aria-hidden="true" />
            </pre>
          </figure>
          <div className={styles.ways}>
            <ul className={cells.cells}>
              {MODES.map((mode) => (
                <li key={mode.key} className={cn(cells.cell, styles.way)}>
                  <svg
                    className={cn(cells.icon, styles.wayIcon)}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    {mode.icon}
                  </svg>
                  <b className={cn(cells.name, styles.wayName)}>
                    {t(`Homepage.interfaces.modes.${mode.key}.title`)}
                  </b>
                  <p className={cn(cells.note, styles.wayNote)}>
                    {t(`Homepage.interfaces.modes.${mode.key}.body`)}
                  </p>
                </li>
              ))}
            </ul>
            <p className={styles.refs}>
              <NavAnchor link={{ href: hrefs.openApi, external: true }}>
                {t("Homepage.interfaces.links.openApi")}
                <span aria-hidden="true"> ↗</span>
              </NavAnchor>
              <NavAnchor link={{ href: hrefs.llms, external: true }}>
                {t("Homepage.interfaces.links.llms")}
                <span aria-hidden="true"> ↗</span>
              </NavAnchor>
              <NavAnchor link={{ href: hrefs.docs }}>
                {t("Homepage.interfaces.links.docs")}
                <span aria-hidden="true"> ↗</span>
              </NavAnchor>
            </p>
          </div>
        </Rise>
      </div>
    </section>
  );
}
