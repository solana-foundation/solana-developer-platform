import type {
  AssetCategory,
  AssetProfile,
  IssuanceMetadata,
  Token,
  TokenStatus,
  TokenTemplate,
} from "@sdp/types";
import { ExternalLink, type LucideIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { profileToDraftState } from "./[tokenId]/asset-profile/asset-profile-mapping";
import { detailFieldOptionLabel, getDetailSections } from "./create/asset-details-config";
import { getCategoryPresentation, getSubTypePresentation } from "./create/asset-taxonomy";
import { safeLinkHref } from "./create/draft-mapping";
import { getTemplateCatalogEntry, type IssuanceTemplateId } from "./template-catalog";

// Shared model + type-aware field logic for the issuance asset list/grid. The
// list's expanded "card" reuses the same category→fields engine as the create
// wizard (getDetailSections + detailFieldOptionLabel) via profileToDraftState,
// so a stablecoin shows peg/backing/reserve and a security shows jurisdiction/
// terms without any list-specific field mapping. Tokens without an asset profile
// (legacy, or the feature flag off) fall back to core token fields.

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export type FieldDepth = "type-aware" | "core";
export type ManageVariant = "link" | "kebab" | "button";
export type TokenView = "grid" | "list";

export interface IssuanceAssetProfileView {
  assetCategory: AssetCategory;
  assetType: string;
  assetTypeVersion: number;
  issuanceMetadata: IssuanceMetadata;
}

export interface IssuanceTokenView {
  id: string;
  name: string;
  symbol: string;
  status: string;
  template: IssuanceTemplateId | "rwa" | string;
  imageUrl: string | null;
  mintAddress: string | null;
  totalSupply: string;
  createdAt: string;
  deployedAt: string | null;
  decimals: number;
  maxSupply: string | null;
  isMintable: boolean;
  isFreezable: boolean;
  requiresAllowlist: boolean;
  description: string | null;
  uri: string | null;
  signingWalletId: string | null;
  assetProfile: IssuanceAssetProfileView | null;
}

// ── Shared formatters / derivations ─────────────────────────────────────────

export function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) {
    return "—";
  }

  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoDateMatch) {
    const [, year, month, day] = isoDateMatch;
    return new Date(`${year}-${month}-${day}T00:00:00`).toLocaleDateString(locale);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(locale);
}

export function formatSupply(value: string, locale: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "0";
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: parsed >= 100 ? 0 : 1,
  }).format(parsed);
}

export function getTokenTypeLabel(template: IssuanceTokenView["template"], t: Translate): string {
  const templateEntry = getTemplateCatalogEntry(template);
  if (templateEntry) {
    return t(`DashboardIssuance.templates.${templateEntry.nameKey}`);
  }

  return template;
}

export function getDeploymentStatus(token: IssuanceTokenView): "draft" | "active" {
  return token.mintAddress || token.deployedAt ? "active" : "draft";
}

// Mirrors getExplorerHref in the token-management utils; kept local so the list
// module has no cross-route dependency.
function explorerHref(mintAddress: string | null): string | null {
  if (!mintAddress) {
    return null;
  }
  const cluster = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() || "devnet";
  const clusterQuery =
    cluster === "mainnet-beta" || cluster === "mainnet"
      ? ""
      : `?cluster=${encodeURIComponent(cluster)}`;
  return `https://explorer.solana.com/address/${mintAddress}${clusterQuery}`;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

// ── Classification chips (Stablecoin / Fiat-backed, etc.) ────────────────────

export interface TokenChip {
  label: string;
  icon: LucideIcon | null;
}

export function getTokenChips(view: IssuanceTokenView, t: Translate): TokenChip[] {
  if (view.assetProfile) {
    const { assetCategory, assetType } = view.assetProfile;
    const category = getCategoryPresentation(assetCategory);
    const subType = getSubTypePresentation(assetCategory, assetType);
    const chips: TokenChip[] = [];
    if (category) {
      chips.push({ label: t(category.labelKey), icon: category.icon });
    }
    if (subType) {
      chips.push({ label: t(subType.labelKey), icon: subType.icon });
    }
    if (chips.length > 0) {
      return chips;
    }
  }
  return [{ label: getTokenTypeLabel(view.template, t), icon: null }];
}

// ── Type-aware expanded fields ───────────────────────────────────────────────

export interface ExpandedField {
  label: string;
  value: string;
  href?: string | null;
}

// Build a Token-shaped object from the list view so profileToDraftState (which
// reads name/symbol/decimals/description/imageUrl/uri/signingWalletId) can run.
// Fields not read by the mapping are filled with inert defaults.
function viewAsToken(view: IssuanceTokenView): Token {
  return {
    id: view.id,
    projectId: "",
    organizationId: "",
    signingWalletId: view.signingWalletId,
    mintAddress: view.mintAddress,
    mintAuthority: null,
    metadataAuthority: null,
    freezeAuthority: null,
    ablListAddress: null,
    name: view.name,
    symbol: view.symbol,
    decimals: view.decimals,
    description: view.description,
    uri: view.uri,
    imageUrl: view.imageUrl,
    template: view.template as TokenTemplate,
    extensions: null,
    totalSupply: view.totalSupply,
    totalSupplyUpdatedAt: null,
    maxSupply: view.maxSupply,
    isMintable: view.isMintable,
    isFreezable: view.isFreezable,
    requiresAllowlist: view.requiresAllowlist,
    status: view.status as TokenStatus,
    deployedAt: view.deployedAt,
    createdBy: "",
    createdAt: view.createdAt,
    updatedAt: view.createdAt,
  };
}

function viewToProfile(profile: IssuanceAssetProfileView, view: IssuanceTokenView): AssetProfile {
  return {
    id: "",
    organizationId: "",
    projectId: "",
    tokenId: view.id,
    assetCategory: profile.assetCategory,
    assetType: profile.assetType,
    assetTypeVersion: profile.assetTypeVersion,
    issuanceMetadata: profile.issuanceMetadata,
    publicMetadata: {},
    status: "active",
    createdBy: null,
    createdAt: view.createdAt,
    updatedAt: view.createdAt,
  };
}

type PushField = (label: string, value: string | null | undefined, href?: string | null) => void;

// The type-specific rows: reuse the create wizard's category→sections engine so
// a stablecoin surfaces peg/backing/reserve and a security surfaces jurisdiction/
// terms, humanizing select values and rendering toggles as yes/no.
function pushTypeAwareFields(view: IssuanceTokenView, t: Translate, push: PushField): void {
  const profile = view.assetProfile;
  if (!profile) {
    return;
  }
  const draft = profileToDraftState(viewToProfile(profile, view), viewAsToken(view));

  for (const section of getDetailSections(profile.assetCategory, profile.assetType)) {
    for (const field of section.fields) {
      const raw = draft[field.key];
      if (field.control === "toggle") {
        push(
          t(field.labelKey),
          raw ? t("DashboardIssuance.list.yes") : t("DashboardIssuance.list.no")
        );
        continue;
      }
      const stored = String(raw ?? "").trim();
      if (!stored) {
        continue;
      }
      const value =
        field.control === "select"
          ? (detailFieldOptionLabel(field.key, stored, t) ?? stored)
          : stored;
      push(t(field.labelKey), value);
    }
  }

  push(t("DashboardIssuance.list.website"), draft.website, safeLinkHref(draft.website));
}

function pushMintAndCreated(
  view: IssuanceTokenView,
  t: Translate,
  locale: string,
  push: PushField
): void {
  if (view.mintAddress) {
    push(
      t("DashboardIssuance.list.mintAddress"),
      shortAddress(view.mintAddress),
      explorerHref(view.mintAddress)
    );
  }
  push(t("DashboardIssuance.list.created"), formatDate(view.createdAt, locale));
}

export function buildExpandedFields(
  view: IssuanceTokenView,
  depth: FieldDepth,
  t: Translate,
  locale: string
): ExpandedField[] {
  const fields: ExpandedField[] = [];
  const push: PushField = (label, value, href) => {
    const normalized = (value ?? "").toString().trim();
    if (!normalized) {
      return;
    }
    fields.push({ label, value: normalized, href: href ?? null });
  };

  if (depth === "type-aware" && view.assetProfile) {
    push(t("DashboardIssuance.list.decimals"), String(view.decimals));
    push(t("DashboardIssuance.list.supply"), formatSupply(view.totalSupply, locale));
    pushTypeAwareFields(view, t, push);
    pushMintAndCreated(view, t, locale, push);
    return fields;
  }

  // Core fields — available for every token regardless of asset profile.
  push(t("DashboardIssuance.list.type"), getTokenTypeLabel(view.template, t));
  push(t("DashboardIssuance.list.decimals"), String(view.decimals));
  push(t("DashboardIssuance.list.supply"), formatSupply(view.totalSupply, locale));
  push(
    t("DashboardIssuance.list.maxSupply"),
    view.maxSupply ? formatSupply(view.maxSupply, locale) : t("DashboardIssuance.list.unlimited")
  );
  push(
    t("DashboardIssuance.list.transfers"),
    view.requiresAllowlist
      ? t("DashboardIssuance.list.restricted")
      : t("DashboardIssuance.list.unrestricted")
  );
  pushMintAndCreated(view, t, locale, push);
  return fields;
}

export function tokenExplorerHref(mintAddress: string | null): string | null {
  return explorerHref(mintAddress);
}

// ── Read-only field row (mirrors SummaryRow from draft-summary-rail) ─────────

export function FieldRow({ label, value, href }: ExpandedField) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-tertiary">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline"
        >
          {value}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <span className="break-words text-sm font-medium text-primary">{value}</span>
      )}
    </div>
  );
}
