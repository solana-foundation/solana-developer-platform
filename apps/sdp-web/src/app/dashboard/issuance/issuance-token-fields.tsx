import type {
  AssetCategory,
  AssetProfile,
  IssuanceMetadata,
  PaymentsDashboardWallet,
  Token,
  TokenStatus,
  TokenTemplate,
} from "@sdp/types";
import {
  Banknote,
  Calculator,
  CalendarClock,
  Compass,
  FileText,
  House,
  Landmark,
  Layers,
  type LucideIcon,
  MapPin,
  Package,
  Percent,
  Receipt,
  Target,
  Vault,
} from "lucide-react";
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
import type { AuthorityControl, AuthorityGlyphRow } from "./asset-overview-hero";
import { type DetailFieldKey, detailFieldOptionLabel } from "./create/asset-details-config";
import { getCategoryPresentation, getSubTypePresentation } from "./create/asset-taxonomy";
import type { DraftState } from "./create/issuance-draft-wizard.types";
import { getTemplateCatalogEntry, type IssuanceTemplateId } from "./template-catalog";
import type { WalletIdentity } from "./wallet-identity";

// Shared model + derivations for the issuance asset list/grid. The list view
// (`IssuanceTokenView`) is a lightweight projection of the full `Token`; adapters
// (`viewAsToken` / `viewToProfile`) rebuild the shapes the shared helpers expect
// so the list's expanded card can reuse the asset-management Overview hero
// (`buildOverviewHeroData`) without any list-specific field mapping.

type Translate = (key: MessageKey, values?: TranslationValues) => string;

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

/**
 * The label for a small logo stand-in, when the asset has no artwork: one
 * character, because most tickers run to four or more. A single initial reads as
 * a monogram, while any longer prefix of a longer symbol reads as truncated —
 * "HRB" beside a real logo looks like a bug rather than a mark. Surfaces with
 * room for the whole symbol should set that instead of a longer prefix. Casing is
 * the issuer's, as everywhere else the symbol appears.
 */
export function tokenMarkInitial(symbol: string): string {
  return symbol.trim().slice(0, 1) || "?";
}

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

/**
 * The token's own status as a dot, a colour and a word — the one place on these
 * surfaces where colour carries meaning. Shared by the asset-management header and
 * the overview tab so the same status cannot read two ways on one page.
 */
export function tokenStatusPresentation(
  t: Translate,
  status: Token["status"]
): { label: string; badgeClassName: string; textClassName: string; dotClassName: string } {
  const presentations: Record<
    Token["status"],
    { label: string; badgeClassName: string; textClassName: string; dotClassName: string }
  > = {
    pending: {
      label: t("DashboardIssuance.status.draft"),
      badgeClassName: "bg-fill text-secondary",
      textClassName: "text-secondary",
      dotClassName: "bg-fill-strong",
    },
    active: {
      label: t("DashboardIssuance.status.active"),
      badgeClassName: "bg-success-bg text-success",
      textClassName: "text-success",
      dotClassName: "bg-success",
    },
    paused: {
      label: t("DashboardIssuance.status.paused"),
      badgeClassName: "bg-warning-bg text-warning",
      textClassName: "text-warning",
      dotClassName: "bg-warning",
    },
    revoked: {
      label: t("DashboardIssuance.status.revoked"),
      badgeClassName: "bg-error-bg text-error",
      textClassName: "text-error",
      dotClassName: "bg-error",
    },
  };
  return presentations[status];
}

export type DeploymentStatus = "draft" | "active" | "paused";

/**
 * The one status a token shows across the list row, the grid tile and the filter.
 *
 * Deployment comes first — a token with no mint is a draft whatever its row says.
 * Past that, `status` is the operator's own state, and `paused` is the one value of
 * it that changes what the token *does*: transfers have stopped. Reporting that as
 * "Active" (which is what collapsing to deployed-or-not did) contradicts the action
 * an operator just took. `revoked` still reads as Active here; it wants the same
 * treatment, but it's a separate state with its own copy.
 */
export function getDeploymentStatus(token: IssuanceTokenView): DeploymentStatus {
  if (!(token.mintAddress || token.deployedAt)) {
    return "draft";
  }
  return token.status === "paused" ? "paused" : "active";
}

// Status is the one place colour carries meaning here: green for live, amber for
// deliberately halted, neutral for not-yet-deployed. Borderless, per the badge rule.
const DEPLOYMENT_STATUS_BADGE: Record<DeploymentStatus, { badge: string; labelKey: MessageKey }> = {
  active: { badge: "bg-success-bg text-success", labelKey: "DashboardIssuance.status.active" },
  paused: { badge: "bg-warning-bg text-warning", labelKey: "DashboardIssuance.status.paused" },
  draft: { badge: "bg-fill text-secondary", labelKey: "DashboardIssuance.status.draft" },
};

/** Badge classes + label for a deployment status, shared by every surface. */
export function deploymentStatusBadge(status: DeploymentStatus, t: Translate) {
  const { badge, labelKey } = DEPLOYMENT_STATUS_BADGE[status];
  return { badge, label: t(labelKey) };
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

export function buildWalletIdentityForAuthority(
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
        walletId: wallet.walletId,
      };
    }
  }
  return { state: control === "external" ? "external" : "unknown", publicKey: address };
}

export function resolveAccessMode(token: Token, draft: DraftState | null): AccessControlMode {
  return draft?.accessControl || getTokenAccessControlMode(token);
}

// The other half of an access decision: whether holders must be identity-verified as
// well as listed. Off-chain policy, so it lives on the profile and nowhere on the
// token — a token with no profile simply doesn't claim it.
export function resolveVerifiedHolders(draft: DraftState | null): boolean {
  return draft?.capacities.kyc.enabled ?? false;
}

export interface CategoryTile {
  icon: LucideIcon;
  label: string;
  value: string;
}

// The expanded card's type-aware slots: up to three category-specific fields, which
// is what makes the card about *this* asset rather than a repeat of the collapsed
// row. Candidates are listed most- to least-significant per category and blank draft
// fields drop out, so a sparse profile simply yields fewer tiles (and a token with no
// profile at all yields none). Sub-type fields are filtered by emptiness rather than
// by branching on `assetType`, so an equity naturally surfaces its share class while
// a fund surfaces its management fee.
// Four, one more than the card has room for, and callers slice the tail off. The cap
// lives above what is rendered on purpose: it keeps the *ordering* decision here, in
// one place per category, so a surface with a spare slot can take the fourth field
// without re-deciding which three come first.
const MAX_CATEGORY_TILES = 4;

function buildCategoryTiles(
  view: IssuanceTokenView,
  draft: DraftState,
  t: Translate
): CategoryTile[] {
  const profile = view.assetProfile;
  if (!profile) {
    return [];
  }
  // Each field carries its own glyph rather than a shared generic tag, so a tile is
  // recognisable before its label is read. Icons repeat only across categories that
  // can never appear together (a stablecoin never shows a property location), so no
  // two tiles on the same card share one.
  const tile = (
    icon: LucideIcon,
    labelKey: MessageKey,
    raw: string,
    humanizeKey?: DetailFieldKey
  ): CategoryTile | null => {
    const value = raw.trim();
    if (!value) {
      return null;
    }
    const display = humanizeKey ? (detailFieldOptionLabel(humanizeKey, value, t) ?? value) : value;
    return { icon, label: t(labelKey), value: display };
  };

  const candidates: Array<CategoryTile | null> =
    profile.assetCategory === "stablecoin"
      ? [
          tile(Banknote, "DashboardIssuance.config.currency", draft.pegCurrency),
          tile(Target, "DashboardIssuance.config.pegTarget", draft.pegTarget),
          tile(Vault, "DashboardIssuance.config.reserveAsset", draft.reserveAsset),
          tile(Landmark, "DashboardIssuance.config.reserveCustodian", draft.reserveCustodian),
        ]
      : profile.assetCategory === "tokenized_security"
        ? [
            tile(
              MapPin,
              "DashboardIssuance.config.jurisdiction",
              draft.jurisdiction,
              "jurisdiction"
            ),
            tile(
              FileText,
              "DashboardIssuance.config.offeringType",
              draft.offeringType,
              "offeringType"
            ),
            tile(Layers, "DashboardIssuance.config.shareClass", draft.shareClass),
            tile(Percent, "DashboardIssuance.config.couponRate", draft.couponRate),
            tile(Receipt, "DashboardIssuance.config.managementFee", draft.managementFee),
            // Fund-shaped securities rarely fill share class or coupon rate, so
            // without these a fund has only two fields to give and comes up short of
            // the card's three slots.
            tile(Compass, "DashboardIssuance.config.fundStrategy", draft.fundStrategy),
            tile(Calculator, "DashboardIssuance.config.netAssetValue", draft.netAssetValue),
            tile(CalendarClock, "DashboardIssuance.config.maturityDate", draft.maturityDate),
          ]
        : profile.assetType === "real_estate"
          ? [
              tile(
                House,
                "DashboardIssuance.config.propertyType",
                draft.propertyType,
                "propertyType"
              ),
              tile(MapPin, "DashboardIssuance.config.propertyLocation", draft.propertyLocation),
              tile(Landmark, "DashboardIssuance.config.custodian", draft.custodian),
            ]
          : [
              tile(Package, "DashboardIssuance.config.underlyingAsset", draft.underlyingAsset),
              tile(Landmark, "DashboardIssuance.config.custodian", draft.custodian),
            ];

  return candidates
    .filter((entry): entry is CategoryTile => entry !== null)
    .slice(0, MAX_CATEGORY_TILES);
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
    walletId: wallet.walletId,
  };
}

export interface ListCardHeroData {
  description: string | null;
  website: string | null;
  mintAddress: string | null;
  /** Compact "supply / max" — e.g. "100K / 2B", or "100K / ∞" when uncapped. Rendered
   *  by the COLLAPSED ROW; the expanded card deliberately does not repeat it. */
  supply: string;
  /** The primary, "smart" date for the collapsed row: the deploy date once deployed,
   *  otherwise the created date. */
  date: { label: string; value: string };
  /** The complementary date, surfaced through the (i) beside the row's date rather
   *  than as a tile of its own: when the draft was created, for a token that has since
   *  been deployed. Null for drafts, whose created date the row already shows, so the
   *  two dates never both occupy space. */
  secondaryDate: { label: string; value: string } | null;
  authorityRows: AuthorityGlyphRow[];
  accessMode: AccessControlMode;
  /** Whether the profile requires identity-verified holders — stated by the access
   *  tile, which is otherwise silent about the other half of an access decision. */
  verifiedHolders: boolean;
  signerWallet: WalletIdentity | null;
  issuer: string | null;
  /** Up to four type-aware fields (peg target, jurisdiction, …), most significant
   *  first; the card renders the first three. See MAX_CATEGORY_TILES. */
  categoryTiles: CategoryTile[];
}

export interface SmartDate {
  label: string;
  value: string;
  /** The complementary date, for the (i) beside the label: when the draft was
   *  created, for a token that has since been deployed. Null for drafts, whose
   *  created date is already the primary value. */
  hint: { label: string; value: string } | null;
}

/**
 * One date instead of two: a deployed token leads with its deploy date and keeps
 * the created date in the (i); a draft just shows created. Shared by the list row,
 * the grid tile and the hero so a token reads the same in all three.
 */
export function buildSmartDate(
  view: IssuanceTokenView,
  t: Translate,
  locale: AppLocale
): SmartDate {
  if (view.deployedAt) {
    return {
      label: t("DashboardIssuance.overview.deployed"),
      value: formatDateLong(view.deployedAt, locale),
      hint: {
        label: t("DashboardIssuance.overview.draftCreated"),
        value: formatDateLong(view.createdAt, locale),
      },
    };
  }
  return {
    label: t("DashboardIssuance.list.created"),
    value: formatDateLong(view.createdAt, locale),
    hint: null,
  };
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
  const smartDate = buildSmartDate(view, t, locale);
  return {
    description: view.description,
    website: draft?.website ?? null,
    mintAddress: view.mintAddress,
    supply: formatSmartSupply(view.totalSupply, view.maxSupply, locale),
    date: smartDate,
    secondaryDate: smartDate.hint,
    authorityRows: buildAuthorityGlyphRows(token, authorityWallets, controlKnown, t),
    accessMode: resolveAccessMode(token, draft),
    verifiedHolders: resolveVerifiedHolders(draft),
    signerWallet: buildWalletIdentityForSigner(view.signingWalletId, authorityWallets, t),
    issuer: draft?.issuerName.trim() || null,
    categoryTiles: draft ? buildCategoryTiles(view, draft, t) : [],
  };
}

export function tokenExplorerHref(mintAddress: string | null): string | null {
  return explorerHref(mintAddress);
}
