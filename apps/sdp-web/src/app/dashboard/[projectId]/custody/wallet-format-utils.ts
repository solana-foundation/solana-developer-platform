import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/** The modules a wallet's copy names, as this deployment's release channel runs them. */
export interface WalletCopyModules {
  ramps: boolean;
  issuance: boolean;
}

/**
 * Who can sign with an active wallet: Payments always, Ramps and Issuance only where the
 * channel runs them, so the band never names a module the API refuses.
 *
 * @param modules - Whether the deployment's release channel runs Ramps and Issuance.
 * @returns The message key for the band's body.
 */
export function walletSignersKey({ ramps, issuance }: WalletCopyModules): MessageKey {
  if (ramps && issuance) return "DashboardCustody.walletStateActiveBody";
  if (ramps) return "DashboardCustody.walletStateActiveBodyRamps";
  if (issuance) return "DashboardCustody.walletStateActiveBodyIssuance";
  return "DashboardCustody.walletStateActiveBodyPayments";
}

export function truncateMiddle(value: string, start = 6, end = 4): string {
  if (value.length <= start + end + 3) {
    return value;
  }

  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function formatWalletMeta(value: string, start = 8, end = 6): string {
  return truncateMiddle(value, start, end);
}

/**
 * A creation date, rendered identically on the server and in the browser.
 *
 * `timeZone` is pinned rather than left to the environment: otherwise the
 * server formats in its zone and the viewer's browser in theirs, and the two
 * disagree often enough — anywhere near midnight UTC — to trip hydration.
 * Returns the raw value for an unparseable date rather than "Invalid Date".
 */
export function formatCreatedDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(locale, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatPurpose(value: string | null, t: Translate): string | null {
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

/**
 * The purpose as the wallet list names it: `formatPurpose`, except that a root wallet says so
 * ("Root wallet") rather than going unnamed.
 */
export function formatWalletPurposeLabel(value: string | null, t: Translate): string | null {
  return value === "root" ? t("DashboardCustody.rootWallet") : formatPurpose(value, t);
}
