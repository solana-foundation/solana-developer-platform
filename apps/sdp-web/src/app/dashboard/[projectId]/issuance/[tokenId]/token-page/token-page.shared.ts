import type { AssetProfile, Token, TokenTransactionStatus } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import type { useTranslations } from "@/i18n/provider";
import { type TokenLifecycle, tokenLifecycle } from "../../issuance-token-state.redesign";
import type { AssetProfileForm } from "../asset-profile/use-asset-profile-form";
import type { TokenOperations } from "../asset-profile/use-token-operations";

type Translate = ReturnType<typeof useTranslations>;

/** The tabs of one token's page, in the header's order. */
export const TOKEN_TABS = [
  "overview",
  "details",
  "public",
  "compliance",
  "operations",
  "permissions",
  "activity",
] as const;

export type TokenTab = (typeof TOKEN_TABS)[number];

export function resolveTokenTab(value: string | null | undefined): TokenTab {
  return TOKEN_TABS.find((tab) => tab === value) ?? "overview";
}

/** A token with no mint's latest deploy transaction, read by the page on the server. */
export interface LatestDeployAttempt {
  status: TokenTransactionStatus;
  error: string | null;
  createdAt: string;
}

export function tokenPageLifecycle(token: Token, latestDeploy: LatestDeployAttempt | null) {
  return tokenLifecycle(token, latestDeploy?.status ?? null);
}

/** "GViwA…ETgu": the start and end of an address. */
export function shortAddress(value: string | null | undefined): string {
  if (!value) return "";
  return value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-4)}` : value;
}

/** "tok_9f12ab41…f8aa": the id's prefix kept whole, then the start and end of the rest. */
export function shortTokenId(value: string): string {
  const separator = value.indexOf("_");
  if (separator < 0) return shortAddress(value);
  return value.length > separator + 13
    ? `${value.slice(0, separator + 9)}…${value.slice(-4)}`
    : value;
}

const CATEGORY_LABEL: Record<string, MessageKey> = {
  stablecoin: "DashboardIssuance.newDesign.classification.stablecoin",
  tokenized_security: "DashboardIssuance.newDesign.classification.tokenizedSecurity",
  generic: "DashboardIssuance.newDesign.classification.digitalToken",
};

const CATEGORY_HELP: Record<string, MessageKey> = {
  stablecoin: "DashboardIssuance.newDesign.classification.stablecoinWhy",
  tokenized_security: "DashboardIssuance.newDesign.classification.tokenizedSecurityWhy",
  generic: "DashboardIssuance.newDesign.classification.digitalTokenWhy",
};

const TYPE_LABEL: Record<string, MessageKey> = {
  fiat_backed: "DashboardIssuance.newDesign.classification.fiatBacked",
  crypto_backed: "DashboardIssuance.newDesign.classification.cryptoBacked",
  equity: "DashboardIssuance.newDesign.classification.equity",
  debt: "DashboardIssuance.newDesign.classification.debt",
  fund: "DashboardIssuance.newDesign.classification.fund",
  commodity: "DashboardIssuance.newDesign.classification.commodity",
  real_estate: "DashboardIssuance.newDesign.classification.realEstate",
  collectible: "DashboardIssuance.newDesign.classification.collectible",
};

/** The classification's name and what it means, from the asset profile. */
export function classificationOf(profile: AssetProfile, t: Translate) {
  const category = CATEGORY_LABEL[profile.assetCategory];
  const help = CATEGORY_HELP[profile.assetCategory];
  const type = TYPE_LABEL[profile.assetType];
  return {
    category: category ? t(category) : profile.assetCategory,
    categoryHelp: help ? t(help) : undefined,
    // "generic" names no sub-type, so the row is left out rather than repeating the category.
    type: type ? t(type) : null,
  };
}

/** Access control as the design words it. */
export function accessControlLabel(mode: "allowlist" | "blocklist" | "disabled", t: Translate) {
  return t(
    mode === "allowlist"
      ? "DashboardIssuance.newDesign.access.allowlist"
      : mode === "blocklist"
        ? "DashboardIssuance.newDesign.access.blocklist"
        : "DashboardIssuance.newDesign.access.off"
  );
}

/** A custody wallet's name for an address, the address itself when SDP holds no such wallet. */
export function holderName(
  address: string | null | undefined,
  wallets: readonly { publicKey: string; label: string | null }[],
  t: Translate
): string {
  if (!address) return t("DashboardIssuance.newDesign.permissions.nobody");
  const wallet = wallets.find((candidate) => candidate.publicKey === address);
  return wallet?.label?.trim() || shortAddress(address);
}

/** What every tab of the page is handed. */
export interface TokenTabProps {
  token: Token;
  assetProfile: AssetProfile;
  ops: TokenOperations;
  form: AssetProfileForm;
  state: TokenLifecycle;
  canManageTokenAdmin: boolean;
}

/** A transaction on explorer.solana.com, on the cluster the dashboard runs against. */
export function transactionExplorerHref(signature: string): string {
  const cluster = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() || "devnet";
  const query =
    cluster === "mainnet-beta" || cluster === "mainnet"
      ? ""
      : `?cluster=${encodeURIComponent(cluster)}`;
  return `https://explorer.solana.com/tx/${signature}${query}`;
}
