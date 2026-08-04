"use client";

import { Popover } from "@base-ui/react/popover";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Ban,
  Coins,
  Copy,
  Globe,
  ListChecks,
  type LucideIcon,
  PenLine,
  Scale,
  Snowflake,
  UserCheck,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { AccessControlMode } from "./access-control.utils";
import { safeLinkHref } from "./create/draft-mapping";
import { type WalletIdentity, WalletIdentityBadge } from "./wallet-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Shared "Identity hero" primitives, used by both the asset-management Overview
// tab and the issuance list's expanded card. The hero itself is a presentational
// SHELL: a description/website/mint-address left column, a caller-composed grid of
// tiles on the right, and an optional footer. Each surface composes its own tiles
// from the exported primitives (StatTile, badges, AuthoritiesGlyph) so the two can
// show different fields while staying visually identical.
// ─────────────────────────────────────────────────────────────────────────────

export interface AssetOverviewHeroProps {
  description: string | null;
  /** Raw website string; the hero derives a safe href itself. */
  website: string | null;
  mintAddress: string | null;
  onCopyMintAddress?: (value: string) => void;
  /** The right-column tiles, composed by the caller from the exported primitives. */
  tiles: ReactNode;
  /** Optional footer rendered inside the card below a divider (e.g. the
   *  Collapse / "Manage this asset" row on the issuance list). Right-aligned;
   *  pass a `w-full` element to lay out both edges. */
  footer?: ReactNode;
}

export function AssetOverviewHero({
  description,
  website,
  mintAddress,
  onCopyMintAddress,
  tiles,
  footer,
}: AssetOverviewHeroProps) {
  const t = useTranslations();
  const websiteValue = website?.trim() ?? "";
  const websiteHref = safeLinkHref(websiteValue);

  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <div className="grid gap-4 md:grid-cols-2 md:gap-5">
        <div className="flex min-w-0 flex-col">
          <p
            className={
              description
                ? "max-w-prose text-[13px] leading-relaxed text-secondary"
                : "text-[13px] text-muted"
            }
          >
            {description || t("DashboardIssuance.overview.noDescription")}
          </p>
          <IdentityFields
            website={websiteValue}
            websiteHref={websiteHref}
            mintAddress={mintAddress}
            onCopy={onCopyMintAddress}
          />
        </div>

        <div className="grid grid-cols-2 gap-x-4 md:gap-0 md:border-l md:border-border-subtle md:pl-5">
          {tiles}
        </div>
      </div>
      {footer ? (
        // Tighter than the gap above the divider on purpose: the footer is a thin
        // action strip, not another content block. `-mb-1` cancels the Close button's
        // own `py-1` — that padding exists for the hit target, not as spacing, and
        // without this the gap below the label reads larger than the card's padding.
        <div className="-mb-1 mt-4 flex justify-end border-t border-border-subtle pt-3">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function IdentityFields({
  website,
  websiteHref,
  mintAddress,
  onCopy,
}: {
  website: string;
  websiteHref: string | undefined;
  mintAddress: string | null;
  onCopy?: (value: string) => void;
}) {
  const t = useTranslations();
  return (
    <div className="mt-6 flex flex-col gap-3 md:mt-auto md:pt-6">
      {website ? (
        <div>
          <div className="flex items-center gap-1.5 text-tertiary">
            <Globe className="h-3 w-3 shrink-0" />
            <span className="text-[11px]">{t("DashboardIssuance.assetDetails.website")}</span>
          </div>
          {websiteHref ? (
            <a
              href={websiteHref}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex w-fit max-w-full items-center gap-1 text-[13px] font-normal text-primary hover:underline"
            >
              <span className="truncate">{website}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <p className="mt-0.5 truncate text-[13px] font-normal text-secondary">{website}</p>
          )}
        </div>
      ) : null}
      <div>
        <div className="flex items-center gap-1.5 text-tertiary">
          <Wallet className="h-3 w-3 shrink-0" />
          <span className="text-[11px]">{t("DashboardIssuance.overview.mintAddress")}</span>
        </div>
        {mintAddress ? (
          <div className="mt-0.5 flex w-fit max-w-full items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-normal text-primary">
              {mintAddress}
            </span>
            {onCopy ? (
              <button
                type="button"
                onClick={() => onCopy(mintAddress)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-fill hover:text-primary"
                aria-label={t("DashboardIssuance.header.copyTokenAddress")}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : (
          <p className="mt-0.5 text-[13px] text-muted">
            {t("DashboardIssuance.overview.notDeployedYet")}
          </p>
        )}
      </div>
    </div>
  );
}

// A right-column stat tile. `wide` spans both grid columns (for long values like
// an issuer name); `clamp` lets a wide tile wrap to two lines then ellipsis.
export function StatTile({
  icon: Icon,
  label,
  value,
  action,
  valueAdornment,
  muted,
  wide,
  clamp,
  framed,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  action?: ReactNode;
  valueAdornment?: ReactNode;
  /** Force the muted colour even when a value is present (e.g. "Not mintable"). */
  muted?: boolean;
  /** Span both columns of the tile grid. */
  wide?: boolean;
  /** Clamp the value to two lines with an ellipsis (pairs with `wide`). */
  clamp?: boolean;
  /** The value paints its own surface — a bordered badge, a row of marks — rather
   *  than being a line of text. Text gets ~6px of optical air under the label for
   *  free from its half-leading; a box's border starts at the padding edge, so it
   *  needs that spacing added back or it sits visibly tighter than its neighbours. */
  framed?: boolean;
  className?: string;
}) {
  const isEmpty = value === null || value === undefined || value === "";
  return (
    // Top-aligned: every value sits directly under its own label. This used to push
    // the value to the bottom (`mt-auto`) so values lined up when a neighbouring
    // *label* wrapped — but labels here are short and rarely wrap, while *values*
    // wrap often (clamped issuer names, long reserve-asset descriptions). Bottom
    // alignment meant one wrapping value dropped its single-line neighbour to the
    // bottom of the row, leaving it visibly detached from its label.
    <div className={cn("flex flex-col py-2.5 md:px-3", wide && "col-span-2", className)}>
      <div className="flex items-center gap-1.5 text-tertiary">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="text-[11px]">{label}</span>
        {/* No wrapper spacing: the row's own gap separates the action from the label,
            and the action manages its own footprint (padding its hit area out with
            canceled margins, the way StatHint does) so it can't inflate the row. */}
        {action}
      </div>
      <div className={cn("flex items-center gap-1.5", framed ? "pt-2" : "pt-0.5")}>
        <span
          className={cn(
            // Same weight as the collapsed row's stat values — the hero is a denser
            // read-out, not a set of headings, so values stay regular weight.
            "min-w-0 text-[13px] font-normal",
            clamp ? "line-clamp-2" : "truncate",
            isEmpty || muted ? "text-muted" : "text-primary"
          )}
        >
          {isEmpty ? "—" : value}
        </span>
        {valueAdornment}
      </div>
    </div>
  );
}

// The authority row's marks: 28px, dropping to 24px below `lg`. From `md` up the hero
// splits into two columns, so the tiles get half a card — and below `lg` that card is
// at its narrowest, where a row of five 28px marks crowds the tile beside it. The
// glyph holds the 24px preset's 14/24 ratio at both sizes, as does its 1px lift off
// the shield's taper.
const MARK_BOX = "h-6 w-6 lg:h-7 lg:w-7";
const MARK_GLYPH = "size-3.5 lg:size-4";
const MARK_GLYPH_LIFT = "-translate-y-px";

// The access marks occlude rather than tint: `--fill` is 8% ink, so the slab band's cut
// edge — which the first mark exists to hide — showed through the silhouette as a seam
// straight down its middle. `--color-fill-opaque` is the same colour composited to be
// opaque (see sdp-theme.css), so nothing behind a mark reaches it.
const MARK_FILL_OPAQUE = "fill-fill-opaque";

// The popover's role chip pins 24px at every width: it shares that popup's grid with
// the wallet badge's 24px provider avatar, not with the hero's tile row.
const CHIP_BOX = "h-6 w-6";
const CHIP_GLYPH = "size-3.5";

// The 10px chip the Control tile states its policies with: a footnote to the marks
// it sits beside, so it stays well under the 13px every tile states a *value* in.
function FootnotePill({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-fill px-1.5 py-0.5 text-[10px] font-medium text-secondary">
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

// Who may hold the asset: the transfer-control mode, and — for an allowlist — whether
// the wallets on it also have to be identity-verified (the `kyc` capacity). "Approved
// wallets" and "approved wallets, identity checked" are different rules, so the second
// mark travels with the first rather than being left to the compliance tab.
//
// Only with an allowlist. Verification is a condition on being *admitted to a set*, and
// the allowlist is that set; beside a blocklist or an unrestricted token there is no set
// it qualifies anyone for, so the same mark would read as an unrelated policy that this
// tile is not about.
//
// Two presentations. Pills are the default: footnotes tucked under the marks in the
// Control tile, each absent when it has nothing to say — a chip reading "no list" is
// noise. `standalone` is for the tile of its own the pair gets once a token deploys
// and the signer stops needing one, where 10px chips alone under a label read as an
// afterthought: there they grow into marks and a value at the scale of the tile's
// neighbours — see StandaloneAccessBadge.
//
// Standalone also has to speak for `disabled`, where the pill stays silent. A tile
// headed "Access control" showing "—" reads as missing data; unrestricted transfer
// is a deliberate configuration, not an absent one, so it gets a real value. Kept
// neutral throughout — these are valid states, and colour here is reserved for status.
export function AccessBadge({
  mode,
  standalone,
  verifiedHolders,
}: {
  mode: AccessControlMode;
  standalone?: boolean;
  /** Whether the asset's compliance profile requires identity-verified holders (the
   *  `kyc` capacity). Stated in both presentations — a second pill in the row, a second
   *  mark in the standalone tile — and only alongside an allowlist. */
  verifiedHolders?: boolean;
}) {
  const t = useTranslations();
  const showVerified = Boolean(verifiedHolders) && mode === "allowlist";
  const { icon: Icon, label } =
    mode === "allowlist"
      ? { icon: ListChecks, label: t("DashboardIssuance.overview.accessAllowlist") }
      : mode === "blocklist"
        ? { icon: Ban, label: t("DashboardIssuance.overview.accessBlocklist") }
        : { icon: ArrowLeftRight, label: t("DashboardIssuance.list.unrestricted") };

  if (standalone) {
    return (
      <StandaloneAccessBadge icon={Icon} label={label} mode={mode} verifiedHolders={showVerified} />
    );
  }

  // No list, no footnote — and with no list there is no verification pill either, by the
  // rule above.
  if (mode === "disabled") {
    return null;
  }

  return (
    <>
      <FootnotePill icon={Icon} label={label} />
      {showVerified ? (
        <FootnotePill icon={UserCheck} label={t("DashboardIssuance.config.kyc")} />
      ) : null}
    </>
  );
}

// The promoted tile's value: a row of marks, then the mode's word. The marks are the
// authority marks' own silhouette at their own 24/28px, because they are the same *kind*
// of fact — a rule this asset is under — and the cluster deliberately mirrors the tile
// next door, which is also a row of shields.
//
// Marks lead and the word trails, rather than the word sitting between them. Two marks
// flanking a word grouped nothing: identical gaps on both sides left the word reading as
// trapped between two unrelated objects. Grouped as a cluster (the marks row's own 6px)
// with a wider gap to the word, the tile reads the way the eye already scans this
// column — marks, then the value they resolve to.
//
// Only the marks hover, same as the authority row: in this hero a mark is the thing you
// interrogate and text is not. Each popup names its own mark before explaining it, which
// is what tells you which of two adjacent shields you are reading — the mode's says who
// may actually hold the asset (because "Allowlist" names a mechanism, not an effect), the
// verification mark's states the identity requirement.
//
// Marks and word share one tinted band, so the tile is a single object rather than a row
// of shields with a caption. The band is cut through the middle of the first mark and
// square on that side: it has no left cap of its own, the mark is what closes it, and the
// value reads as sliding out from behind the mark it belongs to. Geometry, all of it
// measured off the mark rather than chosen:
//
//   · Height. The mark's *box* is 24/28px but its drawn shield only spans y 1.5→23.7 of
//     the 24-unit viewBox (the path runs 2→23.2, plus half of the 1px stroke each way), so
//     the box carries 1.5/1.75px of dead space above the shoulders and 0.3/0.35px below
//     the point. A band on the row's box is that much taller than the shields look;
//     insetting by exactly those amounts makes the edges read as flush with the shape.
//   · The cut. `left` is half a mark — 12px at 24, 14px at 28. The silhouette spans x≈1→27
//     at the shoulders and narrows to its point at 14, so a vertical edge at 14 is inside
//     the shape at every height and the mark hides it completely. That only works because
//     the mark's fill is opaque — see MARK_FILL_OPAQUE, which exists for this.
//   · The tint. 4%, one step under the marks' own 8%: on an equal tint their silhouettes
//     would vanish into the band and leave only their borders.
//
// It is a `::before` rather than a background on the row because both of those edges land
// off the row's own box, and `isolate` + `-z-10` keep the layer behind the marks and the
// word while staying inside the row's stacking context, so it cannot slip behind the card.
// The row does not wrap: a wrapped word would leave the band spanning two lines and its
// height would stop matching the marks, so the word truncates instead.
//
// All neutral: colour on this surface means status, and access control is configuration,
// not a state to flag.
function StandaloneAccessBadge({
  icon: Icon,
  label,
  mode,
  verifiedHolders,
}: {
  icon: LucideIcon;
  label: string;
  mode: AccessControlMode;
  verifiedHolders?: boolean;
}) {
  const t = useTranslations();
  // Optical, not nominal. Blocklist's glyph is a closed circle, so it fills its own box
  // corner to corner where a list or a pair of arrows leaves air around itself — at
  // equal size it reads bigger and much heavier, and inside a shield it crowds the
  // taper. So the closed one takes a notch off the row's glyph size.
  const glyph = mode === "blocklist" ? "size-3 lg:size-3.5" : MARK_GLYPH;

  return (
    <div
      className={cn(
        "relative isolate flex w-fit max-w-full items-center gap-2 pr-2",
        "before:pointer-events-none before:absolute before:top-[1.5px] before:right-0 before:bottom-[0.3px] before:left-3 before:-z-10 before:rounded-r-[10px] before:bg-fill-subtle before:content-['']",
        "lg:before:top-[1.75px] lg:before:bottom-[0.35px] lg:before:left-3.5"
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <AccessMark
          icon={Icon}
          glyph={glyph}
          label={label}
          detail={
            mode === "allowlist"
              ? t("DashboardIssuance.config.accessPolicyAllowlistEffect")
              : mode === "blocklist"
                ? t("DashboardIssuance.config.accessPolicyBlocklistEffect")
                : t("DashboardIssuance.config.accessPolicyDisabledEffect")
          }
        />
        {verifiedHolders ? (
          <AccessMark
            icon={UserCheck}
            // A notch down, for width rather than weight: a figure plus a tick is the
            // widest glyph any of these marks carries, and at the row's own size its
            // ends run into the shield's straight sides.
            glyph="size-3 lg:size-3.5"
            label={t("DashboardIssuance.config.kyc")}
            detail={t("DashboardIssuance.config.kycDescription")}
          />
        ) : null}
      </div>
      <span className="min-w-0 truncate text-[13px] text-primary">{label}</span>
    </div>
  );
}

// One hover-to-reveal mark in the access tile. Same delays, same affordance and same
// popup shape as the authority marks — not an action, so it keeps the arrow cursor and
// dims on hover rather than ringing, and stays a button only to be keyboard-reachable.
function AccessMark({
  icon,
  glyph,
  label,
  detail,
}: {
  icon: LucideIcon;
  glyph: string;
  label: string;
  detail: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={100}
        closeDelay={140}
        aria-label={label}
        className="inline-flex cursor-default outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80"
      >
        <AuthorityShieldMark
          icon={icon}
          glyph={glyph}
          fill={MARK_FILL_OPAQUE}
          className="text-secondary"
        />
      </Popover.Trigger>
      <Popover.Portal>
        {/* Above the workspace's pinned header (z-20), like every other popover on
            this surface — the hero scrolls under it. */}
        <Popover.Positioner side="top" align="center" sideOffset={8} className="z-30">
          <Popover.Popup className="w-[236px] overflow-hidden rounded-xl border border-border-default bg-surface-raised outline-none">
            {/* Built to the authority popover's pattern, down to the width and the
                chip echoing the trigger's glyph — these marks sit in the same tile row,
                so their popups should be the same object. */}
            <div className="px-3 py-2.5">
              <div className="flex items-center justify-center gap-2">
                {/* The shield's mass sits above the middle of its box, so the name
                    takes the same 1px nudge the glyph inside it does. */}
                <p className="min-w-0 -translate-y-px truncate text-[12px] leading-snug font-medium text-primary">
                  {label}
                </p>
                <AuthorityShieldMark
                  icon={icon}
                  box={CHIP_BOX}
                  glyph={CHIP_GLYPH}
                  className="text-secondary"
                />
              </div>
              <p className="mt-2 text-[11px] leading-snug text-secondary">{detail}</p>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export type AuthorityControl = "sdp" | "external" | "none" | "unknown";
export type AuthorityRoleKey = "mint" | "freeze" | "metadata" | "permanentDelegate";

export interface AuthorityGlyphRow {
  role: AuthorityRoleKey;
  /** Whether this authority applies to the token at all (e.g. mintable / freezable
   *  capability present, or a permanent-delegate extension). Non-applicable roles
   *  are not drawn. */
  applicable: boolean;
  /** The displayed authority address (incl. any pending-signer fallback). */
  address: string | null;
  control: AuthorityControl;
  /** `address` + `control` resolved against the custody wallets, so the popover
   *  can name the holder instead of showing a bare address. */
  identity: WalletIdentity;
}

const AUTHORITY_ROLE_META: Record<AuthorityRoleKey, { icon: LucideIcon; labelKey: MessageKey }> = {
  mint: { icon: Coins, labelKey: "DashboardIssuance.forms.mintAuthority" },
  freeze: { icon: Snowflake, labelKey: "DashboardIssuance.forms.freezeAuthority" },
  metadata: { icon: PenLine, labelKey: "DashboardIssuance.forms.metadataAuthority" },
  permanentDelegate: { icon: Scale, labelKey: "DashboardIssuance.forms.permanentDelegate" },
};

// The Authorities tile body: one glyph per applicable authority (green = SDP,
// amber = external / missing-but-required, muted = unknown), each with a hover
// popover naming the role and its holder, plus the transfer-control badge.
export function AuthoritiesGlyph({
  rows,
  accessMode,
  verifiedHolders,
  deployed,
  onCopy,
  onViewPermissions,
  permissionsHref,
  keepAccessBadge,
}: {
  rows: AuthorityGlyphRow[];
  accessMode: AccessControlMode;
  /** Whether holders must be identity-verified — the second policy pill. See
   *  AccessBadge for why it travels with the mode rather than alone. */
  verifiedHolders?: boolean;
  /** Whether the token is on-chain. Drives both where the policy pills live and how
   *  much the marks are willing to claim — see `heldControl`. */
  deployed: boolean;
  onCopy?: (value: string) => void;
  /** Remediation route out of a warning authority's popover. Same-page surfaces
   *  pass `onViewPermissions` (the detail page switches tab, preserving its other
   *  query params); cross-route surfaces pass `permissionsHref` so the action is a
   *  real link. */
  onViewPermissions?: () => void;
  permissionsHref?: string;
  /** Keep the policy pills in the marks row even once deployed. A deployed token
   *  normally has them promoted to a tile of their own — but a surface with no such
   *  tile (the grid tile, where this row is the whole of the control slot) would
   *  otherwise stop stating the access rule the moment a token deploys. */
  keepAccessBadge?: boolean;
}) {
  const t = useTranslations();
  const drawn = rows.filter((row) => row.applicable);
  return (
    // Below the marks rather than beside them: the pills are footnotes to the row, and
    // a row of marks plus two chips is already the widest thing in the tile grid —
    // trailing them keeps the marks from being pushed to a second line first. The pill
    // row wraps on its own so a long policy pair breaks between the chips.
    <div className="flex w-fit flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {drawn.map((row) => {
          const meta = AUTHORITY_ROLE_META[row.role];
          return (
            <AuthorityGlyphIcon
              key={row.role}
              icon={meta.icon}
              label={t(meta.labelKey)}
              control={heldControl(row.control, deployed)}
              identity={row.identity}
              onCopy={onCopy}
              onViewPermissions={onViewPermissions}
              permissionsHref={permissionsHref}
            />
          );
        })}
        {drawn.length === 0 ? <span className="text-[13px] text-muted">—</span> : null}
      </div>
      {/* Deploying promotes the pills to a tile of their own (the one the signer
          vacates), so they drop out of the row there — unless the caller has no tile to
          promote them into. */}
      {deployed && !keepAccessBadge ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          <AccessBadge mode={accessMode} verifiedHolders={verifiedHolders} />
        </div>
      )}
    </div>
  );
}

// Green claims SDP holds this authority. On a draft nothing holds it — there is no
// mint yet — and the address the row carries is a *fallback to the pending signer*
// (getDisplayedAuthorityAddress), i.e. the wallet that will become the authority at
// deploy. Rendering that green states a fact about on-chain control that is not true
// yet, so an undeployed token's held authorities go neutral: intended, not in force.
//
// Warnings survive. An authority planned as external, or required and unset, is still
// worth flagging before deploy — that is exactly when it is cheap to fix.
function heldControl(control: AuthorityControl, deployed: boolean): AuthorityControl {
  return !deployed && control === "sdp" ? "unknown" : control;
}

// Authority glyphs sit in a shield instead of the rounded square used for wallet
// marks — the silhouette itself says "authority", echoing the shield that heads
// the section, and keeps an authority slot visually distinct from its holder.
//
// Hand-drawn rather than lucide's `Shield` because that icon is inset ~4px inside
// its viewBox, leaving a 16×20 silhouette. The mark shares a 24px slot with the
// wallet badge's provider avatar — which fills its box — so the shield has to fill
// its own box (x 1→23, y 2→23.2, leaving only room for the 1px border) or it reads
// as the smaller of two marks that are nominally the same size.
//
// It sits ~0.6px below centre on purpose. A shield's mass is in its upper body, so
// a glyph centred in the box reads as sagging into the taper; the low shield plus
// the glyph's 1px lift (below) balances it while keeping the glyph itself on whole
// pixels — a fractional translate would soften its 2px strokes off-retina.
const AUTHORITY_SHIELD_PATH =
  "M2.8 2h18.4a1.8 1.8 0 0 1 1.8 1.8v8.6c0 4.9-3.7 8.6-11 10.8-7.3-2.2-11-5.9-11-10.8V3.8a1.8 1.8 0 0 1 1.8-1.8Z";

// Tint alone (--t4) left the silhouette almost invisible against the card, so the
// shape carries a border as well — the SDP way to give a surface an edge. Colour
// stays with the glyph: outlining the shield in the status colour too double-encodes
// it and reads as a state pill rather than a container.
//
// The shield is a sibling of the glyph, not a clip-path or mask on the container:
// masking would trim the glyph's lower corners where the shield tapers to its point.
function AuthorityShieldMark({
  icon: Icon,
  box = MARK_BOX,
  glyph = MARK_GLYPH,
  lift = MARK_GLYPH_LIFT,
  fill = "fill-fill",
  className,
}: {
  icon: LucideIcon;
  /** Footprint and glyph size. Default to the authority row's own step, which the
   *  access tile's marks take as well; the popover's role chip is the one caller that
   *  overrides them — see CHIP_BOX for why it doesn't follow the row. */
  box?: string;
  glyph?: string;
  /** The lift off the shield's taper. It is the one part of this mark that does NOT
   *  scale with `box` — a whole pixel is 4% of the 24px box it was drawn for and 6% of
   *  an 18px one, so the smallest marks over-lift and their glyph reads high. Callers
   *  below the row's size pass a smaller one. */
  lift?: string;
  /** The silhouette's fill. Translucent `--fill` by default, which is right for a mark
   *  sitting directly on a card; marks that have to occlude something behind them pass
   *  MARK_FILL_OPAQUE instead. */
  fill?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", box, className)}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 h-full w-full stroke-border-strong",
          fill
        )}
        strokeWidth={1}
      >
        <path d={AUTHORITY_SHIELD_PATH} />
      </svg>
      <Icon className={cn("relative", glyph, lift)} />
    </span>
  );
}

function authorityControlColor(control: AuthorityControl): string {
  switch (control) {
    case "sdp":
      return "text-success";
    case "external":
    case "none":
      return "text-warning";
    default:
      return "text-tertiary";
  }
}

// "Review in Permissions" — a real link when the caller is routing to another
// page, a button when it's switching tabs in place. Same presentation either way.
function PermissionsAction({
  href,
  onClick,
  className,
}: {
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const t = useTranslations();
  const label = t("DashboardIssuance.overview.authoritiesIncompleteLink");
  const styles = cn(
    "inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:decoration-2",
    className
  );

  if (href) {
    return (
      <DashboardNavigationLink href={href} className={styles}>
        {label}
        <ArrowUpRight className="h-3 w-3" />
      </DashboardNavigationLink>
    );
  }
  if (!onClick) {
    return null;
  }
  return (
    <button type="button" onClick={onClick} className={styles}>
      {label}
      <ArrowUpRight className="h-3 w-3" />
    </button>
  );
}

// One shield in the row. Takes its icon, name and holder directly rather than an
// `AuthorityGlyphRow`, so the signer wallet — which is not an authority slot and
// has no role key — can be drawn as one of these too.
function AuthorityGlyphIcon({
  icon: Icon,
  label,
  control,
  identity,
  onCopy,
  onViewPermissions,
  permissionsHref,
}: {
  icon: LucideIcon;
  label: string;
  control: AuthorityControl;
  identity: WalletIdentity;
  onCopy?: (value: string) => void;
  onViewPermissions?: () => void;
  permissionsHref?: string;
}) {
  const t = useTranslations();
  const needsWarning = control === "external" || control === "none";
  // The strip is remediation, so it only earns its space when it has something to
  // say: a hint, a route, or both. The signer glyph passes neither.
  const showRemediation =
    needsWarning && (control === "external" || Boolean(permissionsHref || onViewPermissions));
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={100}
        closeDelay={140}
        aria-label={label}
        className={cn(
          // Hover-to-reveal, not an action: the glyph only surfaces who holds the
          // authority, so it keeps the arrow rather than the global pointer. (It
          // stays a button so it's focusable and the popover is keyboard-reachable.)
          "inline-flex cursor-default outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80",
          authorityControlColor(control)
        )}
      >
        <AuthorityShieldMark icon={Icon} />
      </Popover.Trigger>
      <Popover.Portal>
        {/* Above the workspace's pinned header (z-20): this popover opens upward from
            a row in the scrolling list, so at the top of the list it would otherwise
            land behind the header and only its edges would show. */}
        <Popover.Positioner side="top" align="center" sideOffset={8} className="z-30">
          <Popover.Popup
            className={cn(
              "w-[236px] overflow-hidden rounded-xl border bg-surface-raised outline-none",
              needsWarning ? "border-warning-border" : "border-border-default"
            )}
          >
            {/* The role names the slot; the shared identity badge names its holder,
                so the old separate status line is redundant — "Held externally" /
                "Not set" are the badge's own name line. */}
            <div className="px-3 py-2.5">
              {/* Titles the popup; the chip echoes the trigger's glyph so the two
                  connect. Centred as a pair, chip trailing: the role name is what the
                  popup is for, so it holds the centre and the chip reads as the echo
                  it is — leading, it would take that position and title the popup
                  itself. */}
              <div className="flex items-center justify-center gap-2">
                {/* The shield tapers to a point, so its mass sits above the middle
                    of its box — the same reason the glyph inside it is nudged up a
                    pixel. The label takes that nudge too, otherwise it reads as
                    sitting low against the shape. */}
                <p className="min-w-0 -translate-y-px truncate text-[12px] leading-snug font-medium text-primary">
                  {label}
                </p>
                <AuthorityShieldMark
                  icon={Icon}
                  box={CHIP_BOX}
                  glyph={CHIP_GLYPH}
                  className={authorityControlColor(control)}
                />
              </div>
              <div className="mt-2">
                <WalletIdentityBadge identity={identity} onCopy={onCopy} />
              </div>
            </div>
            {/* Remediation for an authority SDP can't sign for. The popover opens on
                hover but (unlike a tooltip) stays open while the pointer moves onto
                its content, so this action is reachable. */}
            {showRemediation ? (
              <div className="border-t border-warning-border bg-warning-bg px-3 py-2 text-[11px] leading-snug text-warning">
                {control === "external" ? (
                  <p>{t("DashboardIssuance.overview.authorityExternalHint")}</p>
                ) : null}
                <PermissionsAction
                  href={permissionsHref}
                  onClick={onViewPermissions}
                  className={control === "external" ? "mt-1.5" : undefined}
                />
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
