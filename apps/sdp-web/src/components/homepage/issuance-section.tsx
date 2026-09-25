import type { MessageKey } from "@/i18n/messages";
import type { NavLink } from "./homepage-links";
import styles from "./issuance-section.module.css";
import { ProductRow } from "./product-row";

const ROWS = ["standard", "supply", "controls", "authority", "privacy"] as const;

type SectionProps = { t: (key: MessageKey) => string; sandbox: NavLink };

/** "Issue the asset. Control after launch.": the lifecycle, beside an example asset's sheet. */
export function IssuanceSection({ t, sandbox }: SectionProps) {
  return (
    <ProductRow
      id="issuance"
      first
      title={[t("Homepage.issuance.titleFirst"), t("Homepage.issuance.titleSecond")]}
      body={t("Homepage.issuance.body")}
      more={{ link: sandbox, label: t("Homepage.issuance.more") }}
    >
      <dl className={styles.sheet} aria-label={t("Homepage.issuance.sheetLabel")}>
        <div className={styles.item}>
          <dt>
            {t("Homepage.issuance.asset")}
            <em className={styles.example}>{t("Homepage.issuance.example")}</em>
          </dt>
          <dd>{t("Homepage.issuance.rows.kind.value")}</dd>
        </div>
        {ROWS.map((row) => (
          <div key={row} className={styles.item}>
            <dt>{t(`Homepage.issuance.rows.${row}.label`)}</dt>
            <dd>{t(`Homepage.issuance.rows.${row}.value`)}</dd>
          </div>
        ))}
      </dl>
    </ProductRow>
  );
}
