import type {
  CustodyWalletTokenBalance,
  PaymentWalletPolicy,
  PolicyRule,
  WalletControlProfileRevisionHistory,
} from "@sdp/types";
import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { collectDestinationAllowlist, resolveTransferCaps } from "@/lib/wallet-policy-rules";
import { resolveTransferTokenLabel } from "../../payments/payments-overview.utils";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/** "Aug 12, 2026". */
export const POLICY_DATE: Intl.DateTimeFormatOptions = { dateStyle: "medium" };

/** What the wallet's page shows about the wallet itself, resolved on the server. */
export interface WalletPageView {
  walletId: string;
  /** The label, or "Untitled wallet". */
  name: string;
  publicKey: string;
  provider: KnownCustodyProvider | null;
  /** The provider's own name, or the raw provider id when the catalogue does not know it. */
  providerName: string;
  purposeLabel: string | null;
  createdAt: string | null;
  isRuntimeExecutionAllowed: boolean;
  supportsSignerCheck: boolean;
  /** The provider connection it signs through, linked for an admin where BYOK is on. */
  connection: { label: string; href: string | null } | null;
  canManageCustody: boolean;
  label: string | null;
}

export interface WalletBalancesResult {
  balances: CustodyWalletTokenBalance[];
  error: string | null;
}

export interface WalletPolicyResult {
  policy: PaymentWalletPolicy | null;
  error: string | null;
}

export interface WalletRevisionsResult {
  history: WalletControlProfileRevisionHistory | null;
  /** Member names by user id, for a revision's author. */
  userNames: Record<string, string>;
  error: string | null;
}

/** Tokens this organization issued, by mint: their names in balances and activity. */
export type IssuedTokensByMint = Record<
  string,
  { id: string; name: string | null; symbol: string | null }
>;

/** The page's tabs, in order; `policy` shows only where wallet policies are on. */
export const WALLET_TABS = ["overview", "activity", "policy", "settings"] as const;
export type WalletTab = (typeof WALLET_TABS)[number];

export function walletPolicyHref(walletId: string, rest = ""): string {
  return `/dashboard/wallets/${encodeURIComponent(walletId)}/policy${rest}`;
}

/**
 * Symbols by mint for naming amounts: the tokens this organization issued, then what the
 * balances call them (a balance's "symbol" that is only its mint again says nothing).
 */
export function symbolsByMint(
  balances: readonly CustodyWalletTokenBalance[],
  issued: IssuedTokensByMint
): Record<string, string> {
  const symbols: Record<string, string> = {};
  for (const [mint, token] of Object.entries(issued)) {
    if (token.symbol) symbols[mint] = token.symbol;
  }
  for (const balance of balances) {
    const mint = balance.mint?.trim();
    const token = balance.token?.trim();
    if (mint && token && token !== mint) symbols[mint] = token;
  }
  return symbols;
}

/** A policy restricts once any rule narrows it or the default is anything but allow. */
export function policyRestricts(policy: PaymentWalletPolicy | null): boolean {
  if (!policy) return false;
  return policy.defaultAction !== "allow" || policy.rules.length > 0;
}

function allowedAssets(rules: readonly PolicyRule[]): string[] {
  const mints = new Set<string>();
  for (const rule of rules) {
    if (rule.kind !== "asset" || (rule.action && rule.action !== "allow")) continue;
    for (const mint of rule.assets ?? (rule.asset ? [rule.asset] : [])) mints.add(mint);
  }
  return [...mints];
}

function familyName(family: string): string {
  return family
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** "Ramp refused · Issuance needs approval": what the operation rules stop or hold. */
function operationsLine(rules: readonly PolicyRule[], t: Translate): string | null {
  const parts: string[] = [];
  for (const rule of rules) {
    const families =
      rule.kind === "operation_family"
        ? (rule.families ?? (rule.family ? [rule.family] : []))
        : rule.kind === "approval"
          ? (rule.families ?? [])
          : [];
    const held = rule.kind === "approval" || rule.action === "approval_required";
    const refused = rule.kind === "operation_family" && rule.action === "deny";
    for (const family of families) {
      if (refused) {
        parts.push(t("DashboardCustody.walletOperationRefused", { family: familyName(family) }));
      } else if (held) {
        parts.push(
          t("DashboardCustody.walletOperationNeedsApproval", { family: familyName(family) })
        );
      }
    }
  }
  return parts.length ? [...new Set(parts)].join(" · ") : null;
}

/**
 * The Overview's one line about the policy: what it narrows, then the revision enforcing it.
 * Null when there is no policy to describe.
 */
export function policySummaryLine(
  policy: PaymentWalletPolicy,
  issuedSymbols: Record<string, string>,
  locale: string,
  t: Translate
): string | null {
  if (!policyRestricts(policy)) return null;
  const caps = resolveTransferCaps(policy.rules);
  const destinations = collectDestinationAllowlist(policy.rules).length;
  const parts: string[] = [];
  if (caps.length) {
    parts.push(
      t("DashboardCustody.walletPolicySendsUpTo", {
        cap: caps
          .map((cap) => `${cap.max} ${resolveTransferTokenLabel(cap.asset, issuedSymbols)}`)
          .join(", "),
      })
    );
  }
  if (destinations === 1) parts.push(t("DashboardCustody.walletPolicyToOneAddress"));
  if (destinations > 1) {
    parts.push(t("DashboardCustody.walletPolicyToAddresses", { count: destinations }));
  }
  const operations = operationsLine(policy.rules, t);
  if (operations) parts.push(operations);
  if (parts.length === 0) {
    parts.push(
      policy.defaultAction === "deny"
        ? t("DashboardCustody.walletPolicyRefusesByDefault")
        : t("DashboardCustody.walletPolicyHoldsByDefault")
    );
  }
  const profile = policy.controlProfile;
  const since =
    profile?.revisionNumber && profile.activatedAt
      ? t("DashboardCustody.walletPolicyRevisionSince", {
          number: profile.revisionNumber,
          date: new Intl.DateTimeFormat(locale, POLICY_DATE).format(new Date(profile.activatedAt)),
        })
      : null;
  return [`${parts.join(", ")}.`, since].filter(Boolean).join(" ");
}

export interface PolicyRulesView {
  defaultAction: { label: string; tone: "positive" | "attention" | "critical" };
  perTransfer: string;
  allowedTokens: string;
  destinations: string;
  operations: string;
}

/** The Rules part of the Policy tab, in the design's five rows. */
export function policyRulesView(
  policy: PaymentWalletPolicy,
  issuedSymbols: Record<string, string>,
  t: Translate
): PolicyRulesView {
  const caps = resolveTransferCaps(policy.rules);
  const assets = allowedAssets(policy.rules);
  const destinations = collectDestinationAllowlist(policy.rules);
  return {
    defaultAction:
      policy.defaultAction === "allow"
        ? { label: t("DashboardCustody.policyAllowed"), tone: "positive" }
        : policy.defaultAction === "deny"
          ? { label: t("DashboardCustody.policyDenied"), tone: "critical" }
          : { label: t("DashboardCustody.policyApprovalRequired"), tone: "attention" },
    perTransfer: caps.length
      ? caps
          .map((cap) => `${cap.max} ${resolveTransferTokenLabel(cap.asset, issuedSymbols)}`)
          .join(", ")
      : t("DashboardCustody.noCap"),
    allowedTokens: assets.length
      ? assets.map((mint) => resolveTransferTokenLabel(mint, issuedSymbols)).join(", ")
      : t("DashboardCustody.walletAnyToken"),
    destinations:
      destinations.length === 0
        ? t("DashboardCustody.walletAnyAddress")
        : destinations.length === 1
          ? t("DashboardCustody.walletAllowListOne")
          : t("DashboardCustody.walletAllowListCount", { count: destinations.length }),
    operations: operationsLine(policy.rules, t) ?? t("DashboardCustody.walletNoOperationRules"),
  };
}
