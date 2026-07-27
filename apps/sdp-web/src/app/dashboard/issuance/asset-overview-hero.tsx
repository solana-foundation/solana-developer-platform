"use client";

import { Popover } from "@base-ui/react/popover";
import type { CustodyProvider } from "@sdp/types";
import {
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
  TriangleAlert,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { AccessControlMode } from "./access-control.utils";
import { safeLinkHref } from "./create/draft-mapping";

// ─────────────────────────────────────────────────────────────────────────────
// Shared "Identity hero" primitives, used by both the asset-management Overview
// tab and the issuance list's expanded card. The hero itself is a presentational
// SHELL: a description/website/mint-address left column, a caller-composed grid of
// tiles on the right, and an optional footer. Each surface composes its own tiles
// from the exported primitives (StatTile, badges, AuthoritiesGlyph) so the two can
// show different fields while staying visually identical.
// ─────────────────────────────────────────────────────────────────────────────

export function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-4)}` : address;
}

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
        <div className="mt-5 flex justify-end border-t border-border-subtle pt-4">{footer}</div>
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
              className="mt-0.5 inline-flex w-fit max-w-full items-center gap-1 text-[13px] font-medium text-primary hover:underline"
            >
              <span className="truncate">{website}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <p className="mt-0.5 truncate text-[13px] font-medium text-secondary">{website}</p>
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
            <span className="min-w-0 truncate text-[13px] font-medium text-primary">
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
  className?: string;
}) {
  const isEmpty = value === null || value === undefined || value === "";
  return (
    // Full-height flex column so the value bottom-aligns across a grid row even
    // when a neighbouring tile's label wraps to two lines.
    <div className={cn("flex h-full flex-col py-2.5 md:px-3", wide && "col-span-2", className)}>
      <div className="flex items-center gap-1.5 text-tertiary">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="text-[11px]">{label}</span>
        {action ? <span className="-my-1 ml-1">{action}</span> : null}
      </div>
      <div className="mt-auto flex items-center gap-1.5 pt-0.5">
        <span
          className={cn(
            "min-w-0 text-[13px] font-medium",
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

// ── Wallet identity ──────────────────────────────────────────────────────────
// "Who is behind this address / walletId", shared by the Signer wallet tile and
// the authority popovers so both read identically.
//
// `managed` is the only state that resolves to an org custody wallet, and the
// provider mark IS the custody proof — no "SDP managed" pill is needed alongside
// it. The rest differ by surface:
//   · authorities can be `external` (on-chain state, anyone can hold it — the
//     Permissions warning covers this), `none` (unset), or `unknown` (custody
//     wallets not loaded yet, so we can't classify);
//   · a signer can be `default` (none pinned → SDP picks the project's active
//     config at signing time) or `unresolved` (a pinned walletId that no longer
//     resolves). A signer can never be `external`: `signingWalletId` is a custody
//     walletId (the API rejects raw public keys) resolved through createOrgSigner,
//     so SDP must hold the key to sign at all.
export type WalletIdentity =
  | { state: "managed"; name: string; provider: CustodyProvider | null; publicKey: string }
  | { state: "external"; publicKey: string }
  | { state: "unknown"; publicKey: string }
  | { state: "none" }
  | { state: "default" }
  | { state: "unresolved"; walletId: string };

const WARNING_MARK = (
  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-warning-border bg-warning-bg text-warning">
    <TriangleAlert className="h-3.5 w-3.5" />
  </span>
);

// Compact analogue of the locked-signer card (TokenWalletIdentityCard): provider
// mark, name line, then a detail line carrying the shortened key with an inline
// copy. Built to the 24px mark / 28px text rhythm the AuthoritiesGlyph tile
// already uses, so it drops into a hero tile without growing the grid — and it's
// narrow enough to sit inside the authority popovers too.
export function WalletIdentityBadge({
  identity,
  onCopy,
}: {
  identity: WalletIdentity;
  onCopy?: (value: string) => void;
}) {
  const t = useTranslations();
  const keyLabel = t("DashboardIssuance.wallet.publicKey");

  switch (identity.state) {
    case "managed": {
      const providerName = identity.provider ? formatCustodyProviderName(identity.provider) : null;
      return (
        <IdentityShell mark={<WalletProviderMark provider={identity.provider} size="xs" />}>
          <IdentityName>{identity.name}</IdentityName>
          <IdentityDetail>
            <span className="truncate">
              {providerName ? `${providerName} · ` : ""}
              {shortenAddress(identity.publicKey)}
            </span>
            <IdentityCopyButton value={identity.publicKey} label={keyLabel} onCopy={onCopy} />
          </IdentityDetail>
        </IdentityShell>
      );
    }

    case "external":
      return (
        <IdentityShell mark={WARNING_MARK}>
          <IdentityName className="text-warning">
            {t("DashboardIssuance.overview.authorityExternal")}
          </IdentityName>
          <IdentityDetail>
            <span className="truncate">{shortenAddress(identity.publicKey)}</span>
            <IdentityCopyButton value={identity.publicKey} label={keyLabel} onCopy={onCopy} />
          </IdentityDetail>
        </IdentityShell>
      );

    // Custody wallets aren't loaded, so we can't say whose it is — show the
    // address alone rather than claiming managed or external.
    case "unknown":
      return (
        <IdentityShell mark={<WalletProviderMark provider={null} size="xs" />}>
          <IdentityName>{shortenAddress(identity.publicKey)}</IdentityName>
          <IdentityDetail>
            <IdentityCopyButton value={identity.publicKey} label={keyLabel} onCopy={onCopy} />
          </IdentityDetail>
        </IdentityShell>
      );

    case "none":
      return (
        <IdentityShell mark={WARNING_MARK}>
          <IdentityName className="text-warning">
            {t("DashboardIssuance.overview.authorityNotSet")}
          </IdentityName>
        </IdentityShell>
      );

    case "unresolved":
      return (
        <IdentityShell mark={WARNING_MARK}>
          <IdentityName className="text-warning">
            {t("DashboardIssuance.overview.signerUnavailable")}
          </IdentityName>
          <IdentityDetail>
            <span className="truncate">{identity.walletId}</span>
            <IdentityCopyButton
              value={identity.walletId}
              label={t("DashboardIssuance.wallet.walletId")}
              onCopy={onCopy}
            />
          </IdentityDetail>
        </IdentityShell>
      );

    default:
      return (
        <IdentityShell mark={<WalletProviderMark provider={null} size="xs" />}>
          <IdentityName className="text-secondary">
            {t("DashboardIssuance.overview.signerDefault")}
          </IdentityName>
          <IdentityDetail>
            <span className="truncate">{t("DashboardIssuance.overview.signerDefaultHint")}</span>
          </IdentityDetail>
        </IdentityShell>
      );
  }
}

function IdentityShell({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {mark}
      <span className="flex min-w-0 flex-col">{children}</span>
    </span>
  );
}

function IdentityName({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("truncate text-[12px] leading-[15px] font-medium text-primary", className)}>
      {children}
    </span>
  );
}

function IdentityDetail({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-0.5 text-[10px] leading-[13px] text-tertiary">
      {children}
    </span>
  );
}

function IdentityCopyButton({
  value,
  label,
  onCopy,
}: {
  value: string;
  label: string;
  onCopy?: (value: string) => void;
}) {
  const t = useTranslations();
  if (!onCopy) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => onCopy(value)}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-tertiary transition-colors hover:bg-fill hover:text-primary"
      aria-label={t("DashboardIssuance.wallet.copy", { label })}
      title={t("DashboardIssuance.wallet.copy", { label })}
    >
      <Copy className="h-3 w-3" />
    </button>
  );
}

// Allowlist / blocklist transfer-control pill. `disabled` renders nothing.
export function AccessBadge({ mode }: { mode: AccessControlMode }) {
  const t = useTranslations();
  if (mode === "disabled") {
    return null;
  }
  const isAllow = mode === "allowlist";
  const Icon = isAllow ? ListChecks : Ban;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-fill px-1.5 py-0.5 text-[10px] font-medium text-secondary">
      <Icon className="h-3 w-3" />
      {isAllow
        ? t("DashboardIssuance.overview.accessAllowlist")
        : t("DashboardIssuance.overview.accessBlocklist")}
    </span>
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
  onCopy,
  onViewPermissions,
  permissionsHref,
}: {
  rows: AuthorityGlyphRow[];
  accessMode: AccessControlMode;
  onCopy?: (value: string) => void;
  /** Remediation route out of a warning authority's popover. Same-page surfaces
   *  pass `onViewPermissions` (the detail page switches tab, preserving its other
   *  query params); cross-route surfaces pass `permissionsHref` so the action is a
   *  real link. */
  onViewPermissions?: () => void;
  permissionsHref?: string;
}) {
  const drawn = rows.filter((row) => row.applicable);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {drawn.map((row) => (
        <AuthorityGlyphIcon
          key={row.role}
          row={row}
          onCopy={onCopy}
          onViewPermissions={onViewPermissions}
          permissionsHref={permissionsHref}
        />
      ))}
      {drawn.length === 0 ? <span className="text-[13px] text-muted">—</span> : null}
      <AccessBadge mode={accessMode} />
    </div>
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

function AuthorityGlyphIcon({
  row,
  onCopy,
  onViewPermissions,
  permissionsHref,
}: {
  row: AuthorityGlyphRow;
  onCopy?: (value: string) => void;
  onViewPermissions?: () => void;
  permissionsHref?: string;
}) {
  const t = useTranslations();
  const { icon: Icon, labelKey } = AUTHORITY_ROLE_META[row.role];
  const label = t(labelKey);
  const needsWarning = row.control === "external" || row.control === "none";
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={100}
        closeDelay={140}
        aria-label={label}
        className={cn(
          "inline-flex h-6 w-6 items-center justify-center rounded-md bg-fill-subtle outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80",
          authorityControlColor(row.control)
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="center" sideOffset={8} className="z-50">
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
              <p className="text-[12px] leading-snug font-medium text-primary">{label}</p>
              <div className="mt-2">
                <WalletIdentityBadge identity={row.identity} onCopy={onCopy} />
              </div>
            </div>
            {/* Remediation for an authority SDP can't sign for. The popover opens on
                hover but (unlike a tooltip) stays open while the pointer moves onto
                its content, so this action is reachable. */}
            {needsWarning ? (
              <div className="border-t border-warning-border bg-warning-bg px-3 py-2 text-[11px] leading-snug text-warning">
                {row.control === "external" ? (
                  <p>{t("DashboardIssuance.overview.authorityExternalHint")}</p>
                ) : null}
                <PermissionsAction
                  href={permissionsHref}
                  onClick={onViewPermissions}
                  className={row.control === "external" ? "mt-1.5" : undefined}
                />
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
