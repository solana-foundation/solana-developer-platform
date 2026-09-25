import type { MessageKey } from "@/i18n/messages";
import cells from "./hairline-cells.module.css";
import type { NavLink } from "./homepage-links";
import { ProductRow } from "./product-row";
import { SpeedLanes } from "./speed-lanes";

/** The six ways to move money, each with the design's line icon. */
const MODES = [
  { key: "pay", paths: ["M7 17 17 7", "M8 7h9v9"] },
  { key: "request", paths: ["M6 3h9l4 4v14H6Z", "M14 3v5h5", "M9 13h6M9 17h6"] },
  {
    key: "recurring",
    paths: [
      "m17 2 4 4-4 4",
      "M3 11V9a4 4 0 0 1 4-4h14",
      "m7 22-4-4 4-4",
      "M21 13v2a4 4 0 0 1-4 4H3",
    ],
  },
  { key: "batch", paths: ["m12 3 9 5-9 5-9-5 9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"] },
  { key: "micro", circles: [8, 16] },
  { key: "deposit", paths: ["M12 4v11", "m7 10 5 5 5-5", "M4 20h16"] },
] as const;

type SectionProps = { t: (key: MessageKey) => string; sandbox: NavLink };

/** "Stablecoins and fiat, one payments API.": one payment crossing the rail, and the six ways. */
export function PaymentsSection({ t, sandbox }: SectionProps) {
  return (
    <ProductRow
      id="payments"
      flip
      wideVisual
      title={[t("Homepage.payments.titleFirst"), t("Homepage.payments.titleSecond")]}
      body={t("Homepage.payments.body")}
      more={{ link: sandbox, label: t("Homepage.payments.more") }}
    >
      <SpeedLanes mode="one" label="Homepage.payments.speedLabel" />
      <ul className={cells.cells}>
        {MODES.map((mode) => (
          <li key={mode.key} className={cells.cell}>
            <svg className={cells.icon} viewBox="0 0 24 24" aria-hidden="true">
              {"paths" in mode
                ? mode.paths.map((d) => <path key={d} d={d} />)
                : mode.circles.map((cx) => <circle key={cx} cx={cx} cy="12" r="5" />)}
            </svg>
            <b className={cells.name}>{t(`Homepage.payments.modes.${mode.key}.title`)}</b>
            <p className={cells.note}>{t(`Homepage.payments.modes.${mode.key}.body`)}</p>
          </li>
        ))}
      </ul>
    </ProductRow>
  );
}
