import type {
  AssetCategory,
  AssetProfile,
  IssuanceMetadata,
  PaymentsDashboardWallet,
  Token,
  TokenStatus,
  TokenTemplate,
} from "@sdp/types";
import type { LucideIcon } from "lucide-react";
import type { AppLocale } from "@/i18n/config";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { profileToDraftState } from "./[tokenId]/asset-profile/asset-profile-mapping";
import {
  classifyAuthorityControl,
  findWalletByPublicKey,
  findWalletByWalletId,
  formatDate as formatDateLong,
  getDisplayedAuthorityAddress,
} from "./[tokenId]/token-management-workspace.utils";
import { type AccessControlMode, getTokenAccessControlMode } from "./access-control.utils";
import type { AuthorityControl, AuthorityGlyphRow, WalletIdentity } from "./asset-overview-hero";
import { type DetailFieldKey, detailFieldOptionLabel } from "./create/asset-details-config";
import { getCategoryPresentation, getSubTypePresentation } from "./create/asset-taxonomy";
import type { DraftState } from "./create/issuance-draft-wizard.types";
import { getTemplateCatalogEntry, type IssuanceTemplateId } from "./template-catalog";

// Shared model + derivations for the issuance asset list/grid. The list view
// (`IssuanceTokenView`) is a lightweight projection of the full `Token`; adapters
// (`viewAsToken` / `viewToProfile`) rebuild the shapes the shared helpers expect
// so the list's expanded card can reuse the asset-management Overview hero
// (`buildOverviewHeroData`) without any list-specific field mapping.

type Translate = (key: MessageKey, values?: TranslationValues) => string;

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
  mintAuthority: string | null;
  metadataAuthority: string | null;
  freezeAuthority: string | null;
  permanentDelegate: string | null;
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

export function formatSmartSupply(
  totalSupply: string,
  maxSupply: string | null,
  locale: string
): string {
  const max = maxSupply ? formatSupply(maxSupply, locale) : "∞";
  return `${formatSupply(totalSupply, locale)} / ${max}`;
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
    mintAuthority: view.mintAuthority,
    metadataAuthority: view.metadataAuthority,
    freezeAuthority: view.freezeAuthority,
    ablListAddress: null,
    name: view.name,
    symbol: view.symbol,
    decimals: view.decimals,
    description: view.description,
    uri: view.uri,
    imageUrl: view.imageUrl,
    template: view.template as TokenTemplate,
    extensions: view.permanentDelegate ? { permanentDelegate: view.permanentDelegate } : null,
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

const AUTHORITY_ROLES = ["mint", "freeze", "metadata", "permanentDelegate"] as const;

export function buildAuthorityGlyphRows(
  token: Token,
  authorityWallets: PaymentsDashboardWallet[],
  controlKnown: boolean,
  t: Translate
): AuthorityGlyphRow[] {
  const metadataAuthority = token.metadataAuthority ?? token.mintAuthority;
  return AUTHORITY_ROLES.map((role) => {
    const address = getDisplayedAuthorityAddress({
      token,
      role,
      metadataAuthority,
      authorityWallets,
    });
    const applicable =
      role === "mint"
        ? token.isMintable
        : role === "freeze"
          ? token.isFreezable
          : role === "metadata"
            ? true
            : address !== null;
    const control = classifyAuthorityControl(address, authorityWallets, controlKnown);
    return {
      role,
      applicable,
      address,
      control,
      identity: buildWalletIdentityForAuthority(address, control, authorityWallets, t),
    };
  });
}

function buildWalletIdentityForAuthority(
  address: string | null,
  control: AuthorityControl,
  authorityWallets: PaymentsDashboardWallet[],
  t: Translate
): WalletIdentity {
  if (!address) {
    return { state: "none" };
  }
  if (control === "sdp") {
    const wallet = findWalletByPublicKey(authorityWallets, address);
    if (wallet) {
      return {
        state: "managed",
        name: wallet.label?.trim() || t("DashboardIssuance.wallet.unlabeled"),
        provider: wallet.provider ?? null,
        publicKey: wallet.publicKey,
      };
    }
  }
  return { state: control === "external" ? "external" : "unknown", publicKey: address };
}

export function resolveAccessMode(token: Token, draft: DraftState | null): AccessControlMode {
  return draft?.accessControl || getTokenAccessControlMode(token);
}

function buildCategoryTile(
  view: IssuanceTokenView,
  draft: DraftState,
  t: Translate
): { label: string; value: string } | null {
  const profile = view.assetProfile;
  if (!profile) {
    return null;
  }
  const tile = (labelKey: MessageKey, raw: string, humanizeKey?: DetailFieldKey) => {
    const value = raw.trim();
    if (!value) {
      return null;
    }
    const display = humanizeKey ? (detailFieldOptionLabel(humanizeKey, value, t) ?? value) : value;
    return { label: t(labelKey), value: display };
  };
  if (profile.assetCategory === "stablecoin") {
    return tile("DashboardIssuance.config.currency", draft.pegCurrency);
  }
  if (profile.assetCategory === "tokenized_security") {
    return tile("DashboardIssuance.config.jurisdiction", draft.jurisdiction, "jurisdiction");
  }
  if (profile.assetType === "real_estate") {
    return tile("DashboardIssuance.config.propertyType", draft.propertyType, "propertyType");
  }
  return tile("DashboardIssuance.config.underlyingAsset", draft.underlyingAsset);
}

export function buildWalletIdentityForSigner(
  signingWalletId: string | null | undefined,
  authorityWallets: PaymentsDashboardWallet[],
  t: Translate
): WalletIdentity | null {
  if (!signingWalletId) {
    return { state: "default" };
  }
  if (authorityWallets.length === 0) {
    return null;
  }
  const wallet = findWalletByWalletId(authorityWallets, signingWalletId);
  if (!wallet) {
    return { state: "unresolved", walletId: signingWalletId };
  }
  return {
    state: "managed",
    name: wallet.label?.trim() || t("DashboardIssuance.wallet.unlabeled"),
    provider: wallet.provider ?? null,
    publicKey: wallet.publicKey,
  };
}

export interface ListCardHeroData {
  description: string | null;
  website: string | null;
  mintAddress: string | null;
  /** Compact "supply / max" — e.g. "100K / 2B", or "100K / ∞" when uncapped. */
  supply: string;
  /** Smart date: deployed tokens show the deploy date, drafts the created date. */
  date: { label: string; value: string; tooltip: string };
  authorityRows: AuthorityGlyphRow[];
  accessMode: AccessControlMode;
  signerWallet: WalletIdentity | null;
  issuer: string | null;
  category: { label: string; value: string } | null;
}

export function buildOverviewHeroData(
  view: IssuanceTokenView,
  authorityWallets: PaymentsDashboardWallet[],
  t: Translate,
  locale: AppLocale
): ListCardHeroData {
  const token = viewAsToken(view);
  const controlKnown = authorityWallets.length > 0;
  const draft = view.assetProfile
    ? profileToDraftState(viewToProfile(view.assetProfile, view), token)
    : null;
  const deployed = Boolean(view.deployedAt);
  return {
    description: view.description,
    website: draft?.website ?? null,
    mintAddress: view.mintAddress,
    supply: formatSmartSupply(view.totalSupply, view.maxSupply, locale),
    date: deployed
      ? {
          label: t("DashboardIssuance.overview.deployed"),
          value: formatDateLong(view.deployedAt, locale),
          tooltip: t("DashboardIssuance.overview.deployedTooltip"),
        }
      : {
          label: t("DashboardIssuance.list.created"),
          value: formatDateLong(view.createdAt, locale),
          tooltip: t("DashboardIssuance.overview.createdTooltip"),
        },
    authorityRows: buildAuthorityGlyphRows(token, authorityWallets, controlKnown, t),
    accessMode: resolveAccessMode(token, draft),
    signerWallet: buildWalletIdentityForSigner(view.signingWalletId, authorityWallets, t),
    issuer: draft?.issuerName.trim() || null,
    category: draft ? buildCategoryTile(view, draft, t) : null,
  };
}

export function tokenExplorerHref(mintAddress: string | null): string | null {
  return explorerHref(mintAddress);
}
