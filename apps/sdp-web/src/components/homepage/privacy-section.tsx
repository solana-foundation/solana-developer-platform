import type { MessageKey } from "@/i18n/messages";
import type { NavLink } from "./homepage-links";
import { PrivateWords } from "./private-words";
import { ProductRow } from "./product-row";

type SectionProps = { t: (key: MessageKey) => string; sandbox: NavLink };

/** "Confidential per operation.": what stays off the public ledger, one word at a time. */
export function PrivacySection({ t, sandbox }: SectionProps) {
  return (
    <ProductRow
      id="privacy"
      flip
      centered
      title={[t("Homepage.privacy.titleFirst"), t("Homepage.privacy.titleSecond")]}
      body={t("Homepage.privacy.body")}
      more={{ link: sandbox, label: t("Homepage.privacy.more") }}
    >
      <PrivateWords />
    </ProductRow>
  );
}
