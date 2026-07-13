import type { MessageKey, TranslationValues } from "@/i18n/messages";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function truncateMiddle(value: string, start = 6, end = 4): string {
  if (value.length <= start + end + 3) {
    return value;
  }

  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function formatWalletMeta(value: string, start = 8, end = 6): string {
  return truncateMiddle(value, start, end);
}

export function formatPurpose(value: string | null, t: Translate): string | null {
  if (!value) {
    return null;
  }

  switch (value) {
    case "root":
      return null;
    case "mint_authority":
      return t("DashboardCustody.mintAuthority");
    case "freeze_authority":
      return t("DashboardCustody.freezeAuthority");
    case "fee_payer":
      return t("DashboardCustody.feePayer");
    case "transfer":
      return t("DashboardCustody.transfers");
    default:
      return value.replaceAll("_", " ");
  }
}
