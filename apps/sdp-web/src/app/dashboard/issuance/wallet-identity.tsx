"use client";

import type { CustodyProvider, PaymentsDashboardWallet } from "@sdp/types";
import { ArrowUpRight, Copy, KeyRound, type LucideIcon, TriangleAlert, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// "Who is behind this address / walletId" — one model, two renderings, shared by
// every issuance surface that names a wallet or an authority holder: the hero's
// Signer wallet tile, the authority popovers and the Permissions rows (compact),
// and the signer select + authority modal (card).
//
// Lives at the issuance root rather than under [tokenId]/ because its consumers
// sit on both sides of that route boundary.
// ─────────────────────────────────────────────────────────────────────────────

export function shortenAddress(address: string, lead = 5, tail = 4): string {
  return address.length > lead + tail + 3
    ? `${address.slice(0, lead)}…${address.slice(-tail)}`
    : address;
}

// A `managed` badge spends its detail line on "Provider · key", so the key is
// clipped hard. The states that show an address alone have the whole line to
// themselves — spend it, since more characters is exactly what you need when
// eyeballing an address SDP doesn't control.
//
// Sized to render at about the same width as a typical managed detail line
// ("Local Signer · GXpHv…aCQC", 25 chars) so badges stacked in a column don't
// have one line looking half-empty. Fewer characters than that, because base58
// skews to capitals and digits, which are wider than the lowercase provider text
// they're matching — the tail carries the odd one out.
const STANDALONE_ADDRESS_LEAD = 11;
const STANDALONE_ADDRESS_TAIL = 10;

function standaloneAddress(address: string): string {
  return shortenAddress(address, STANDALONE_ADDRESS_LEAD, STANDALONE_ADDRESS_TAIL);
}

// An address standing in for a *name* is a different budget: the name line is 12px, so
// it runs ~20% wider per character than the 10px detail line the standalone form above
// was measured against. At 22 characters it overflows the narrowest surfaces this badge
// renders on — the 236px authority popover and the 216px settings column both leave it
// about 162px — and `truncate` then adds its own ellipsis on top of the manual one. Two
// ellipses in one address, with the tail clipped away: the half you actually compare
// when checking which key this is. 8+8 fits both, with the inline copy beside it.
const NAME_ADDRESS_LEAD = 8;
const NAME_ADDRESS_TAIL = 8;

function nameAddress(address: string): string {
  return shortenAddress(address, NAME_ADDRESS_LEAD, NAME_ADDRESS_TAIL);
}

// `managed` is the only state that resolves to an org custody wallet, and the
// provider mark IS the custody proof — no "SDP managed" pill is needed alongside
// it. The rest differ by surface:
//   · authorities can be `external` (on-chain state, anyone can hold it — the
//     Permissions warning covers this), `none` (unset), or `unknown` (custody
//     wallets not loaded yet, so we can't classify);
//   · forms can be `custom` — an address you typed that isn't one of your wallets.
//     Deliberately NOT the same state as `external`: that one reports a status SDP
//     cannot sign for (amber), this one previews a value you chose (neutral). The
//     payloads are identical and both render as a card, so the wording cannot be
//     derived from the variant — it has to live in the state;
//   · a signer can be `default` (none pinned → SDP picks the project's active
//     config at signing time) or `unresolved` (a pinned walletId that no longer
//     resolves). A signer can never be `external`: `signingWalletId` is a custody
//     walletId (the API rejects raw public keys) resolved through createOrgSigner,
//     so SDP must hold the key to sign at all.
export type WalletIdentity =
  | {
      state: "managed";
      name: string;
      provider: CustodyProvider | null;
      publicKey: string;
      /** Custody walletId — the badge links its name to that wallet's page. */
      walletId: string;
    }
  | { state: "external"; publicKey: string }
  | { state: "custom"; publicKey: string }
  | { state: "unknown"; publicKey: string }
  | { state: "none" }
  | { state: "default" }
  | { state: "unresolved"; walletId: string };

/**
 * Map a resolved custody wallet — or a raw address when none resolved — to an
 * identity. `unresolvedAs` is required rather than defaulted because the two
 * framings are not interchangeable (see the `custom` note above): callers
 * reporting existing on-chain state pass "external", callers previewing typed
 * input pass "custom".
 */
export function toWalletIdentity(
  wallet: PaymentsDashboardWallet | null | undefined,
  rawAddress: string | null | undefined,
  { unresolvedAs, unlabeled }: { unresolvedAs: "external" | "custom"; unlabeled: string }
): WalletIdentity {
  if (wallet) {
    return {
      state: "managed",
      name: wallet.label?.trim() || unlabeled,
      provider: wallet.provider ?? null,
      publicKey: wallet.publicKey,
      walletId: wallet.walletId,
    };
  }

  const trimmed = rawAddress?.trim();
  if (!trimmed) {
    return { state: "none" };
  }
  return { state: unresolvedAs, publicKey: trimmed };
}

/**
 * How the wallet name navigates to its page. `same-tab` for read-only displays
 * where leaving costs nothing; `new-tab` when the surrounding surface holds
 * unsaved state (a modal or form) that in-place navigation would tear down.
 */
export type WalletLinkTarget = "same-tab" | "new-tab";

function walletHref(walletId: string): string {
  return `/dashboard/wallets/${encodeURIComponent(walletId)}`;
}

export function WalletIdentityBadge({
  identity,
  onCopy,
  variant = "compact",
  walletLink = "same-tab",
  className,
}: {
  identity: WalletIdentity;
  /** Compact only — the card copies to the clipboard itself, see CardCopyButton. */
  onCopy?: (value: string) => void;
  variant?: "compact" | "card";
  walletLink?: WalletLinkTarget;
  /** Sizing hook for callers that stack badges in a column and need them to align
   *  — the content is intrinsically ragged (a wallet name vs. "Held externally"),
   *  so a fixed width has to come from the list, not the badge. */
  className?: string;
}) {
  return variant === "card" ? (
    <IdentityCard identity={identity} walletLink={walletLink} className={className} />
  ) : (
    <CompactIdentity
      identity={identity}
      onCopy={onCopy}
      walletLink={walletLink}
      className={className}
    />
  );
}

// Nothing marks the name as a link at rest — the badge is a dense read-out and a
// permanent underline or glyph on every one of them is noise. Hovering anywhere on
// the badge (see WALLET_HOVER_GROUP on the two shells) reveals both at once, so the
// whole item acts as the hover target while only the name is clickable.
//
// The arrow is always laid out and only its opacity animates: revealing it by
// mounting it would steal ~14px from the truncating name mid-hover and reflow the
// line under the pointer.
const WALLET_HOVER_GROUP = "group/wallet";

function WalletNameLink({
  walletId,
  target,
  title,
  className,
  children,
}: {
  walletId: string;
  target: WalletLinkTarget;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <WalletLinkAnchor
      href={walletHref(walletId)}
      target={target}
      title={title}
      className={cn(
        "inline-flex w-fit max-w-full items-center gap-1 underline decoration-transparent decoration-1 underline-offset-2 transition-colors group-hover/wallet:decoration-current",
        className
      )}
    >
      <span className="truncate">{children}</span>
      <ArrowUpRight
        className="h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover/wallet:opacity-100"
        aria-hidden="true"
      />
    </WalletLinkAnchor>
  );
}

// New-tab uses a plain anchor rather than DashboardNavigationLink: Next's Link
// would work (it treats a non-_self target as a modified event and hands the click
// to the browser without announcing a navigation), but it would still prefetch a
// route this tab is never going to render.
function WalletLinkAnchor({
  href,
  target,
  title,
  ariaLabel,
  className,
  children,
}: {
  href: string;
  target: WalletLinkTarget;
  title?: string;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  if (target === "new-tab") {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={title}
        aria-label={ariaLabel}
        className={className}
      >
        {children}
      </a>
    );
  }
  return (
    <DashboardNavigationLink href={href} title={title} aria-label={ariaLabel} className={className}>
      {children}
    </DashboardNavigationLink>
  );
}

// ── Compact ──────────────────────────────────────────────────────────────────
// Provider mark, name line, then a detail line carrying the shortened key with an
// inline copy. Built to the 24px mark / 28px text rhythm the AuthoritiesGlyph tile
// already uses, so it drops into a hero tile without growing the grid — and it is
// narrow enough to sit inside the authority popovers too.

const WARNING_MARK = (
  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-warning-border bg-warning-bg text-warning">
    <TriangleAlert className="h-3.5 w-3.5" />
  </span>
);

function CompactIdentity({
  identity,
  onCopy,
  walletLink,
  className,
}: {
  identity: WalletIdentity;
  onCopy?: (value: string) => void;
  walletLink: WalletLinkTarget;
  className?: string;
}) {
  const t = useTranslations();
  const keyLabel = t("DashboardIssuance.wallet.publicKey");

  switch (identity.state) {
    case "managed": {
      const providerName = identity.provider ? formatCustodyProviderName(identity.provider) : null;
      return (
        <CompactShell
          className={className}
          mark={<WalletProviderMark provider={identity.provider} size="xs" />}
        >
          {/* Only the name navigates. Keeping the badge itself inert leaves copy and
              open as two separate, unmistakable targets — and the badge renders in
              hover popovers, where a full-card hit area would catch stray pointers.
              The trailing arrow matches the hero's Website field. */}
          <WalletNameLink
            walletId={identity.walletId}
            target={walletLink}
            title={identity.name}
            className="min-w-0 text-[12px] leading-[15px] font-normal text-primary"
          >
            {identity.name}
          </WalletNameLink>
          <CompactDetail>
            <span className="truncate">
              {providerName ? `${providerName} · ` : ""}
              {shortenAddress(identity.publicKey)}
            </span>
            <CompactCopyButton value={identity.publicKey} label={keyLabel} onCopy={onCopy} />
          </CompactDetail>
        </CompactShell>
      );
    }

    case "external":
      return (
        <CompactShell className={className} mark={WARNING_MARK}>
          <CompactName className="text-warning">
            {t("DashboardIssuance.overview.authorityExternal")}
          </CompactName>
          <CompactDetail>
            <span className="truncate">{standaloneAddress(identity.publicKey)}</span>
            <CompactCopyButton value={identity.publicKey} label={keyLabel} onCopy={onCopy} />
          </CompactDetail>
        </CompactShell>
      );

    case "custom":
      return (
        <CompactShell className={className} mark={<WalletProviderMark provider={null} size="xs" />}>
          <CompactName>{t("DashboardIssuance.wallet.customAddress")}</CompactName>
          <CompactDetail>
            <span className="truncate">{standaloneAddress(identity.publicKey)}</span>
            <CompactCopyButton value={identity.publicKey} label={keyLabel} onCopy={onCopy} />
          </CompactDetail>
        </CompactShell>
      );

    // Custody wallets aren't loaded, so we can't say whose it is — show the
    // address alone rather than claiming managed or external.
    //
    // The address takes the name line and the copy sits inline with it. This is the one
    // state with nothing to say on a detail line, and putting the copy there alone left
    // a 16px glyph orphaned under the address, holding open a second line for itself.
    case "unknown":
      return (
        <CompactShell className={className} mark={<WalletProviderMark provider={null} size="xs" />}>
          <span className="flex min-w-0 items-center gap-1">
            <CompactName>{nameAddress(identity.publicKey)}</CompactName>
            <CompactCopyButton value={identity.publicKey} label={keyLabel} onCopy={onCopy} />
          </span>
        </CompactShell>
      );

    case "none":
      return (
        <CompactShell className={className} mark={WARNING_MARK}>
          <CompactName className="text-warning">
            {t("DashboardIssuance.overview.authorityNotSet")}
          </CompactName>
        </CompactShell>
      );

    case "unresolved":
      return (
        <CompactShell className={className} mark={WARNING_MARK}>
          <CompactName className="text-warning">
            {t("DashboardIssuance.overview.signerUnavailable")}
          </CompactName>
          <CompactDetail>
            <span className="truncate">{identity.walletId}</span>
            <CompactCopyButton
              value={identity.walletId}
              label={t("DashboardIssuance.wallet.walletId")}
              onCopy={onCopy}
            />
          </CompactDetail>
        </CompactShell>
      );

    default:
      return (
        <CompactShell className={className} mark={<WalletProviderMark provider={null} size="xs" />}>
          <CompactName className="text-secondary">
            {t("DashboardIssuance.overview.signerDefault")}
          </CompactName>
          <CompactDetail>
            <span className="truncate">{t("DashboardIssuance.overview.signerDefaultHint")}</span>
          </CompactDetail>
        </CompactShell>
      );
  }
}

function CompactShell({
  mark,
  children,
  className,
}: {
  mark: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        WALLET_HOVER_GROUP,
        // Bordered and tinted so each badge reads as its own object in a stack of
        // rows, rather than as loose text sitting on the row.
        "flex min-w-0 items-center gap-2 rounded-lg border border-border-default bg-fill-subtle px-2 py-1.5",
        className
      )}
    >
      {mark}
      <span className="flex min-w-0 flex-col">{children}</span>
    </span>
  );
}

function CompactName({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "min-w-0 truncate text-[12px] leading-[15px] font-normal text-primary",
        className
      )}
    >
      {children}
    </span>
  );
}

function CompactDetail({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-0.5 text-[10px] leading-[13px] text-tertiary">
      {children}
    </span>
  );
}

function CompactCopyButton({
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
      // Box stays 16px so the hit area doesn't shrink with the glyph.
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-tertiary transition-colors hover:bg-fill hover:text-primary"
      aria-label={t("DashboardIssuance.wallet.copy", { label })}
      title={t("DashboardIssuance.wallet.copy", { label })}
    >
      <Copy className="h-2.5 w-2.5" />
    </button>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────
// The full-size panel used where a wallet is the subject of the screen rather
// than a field on it: the locked signer select, and the authority modal's current
// / selected panels. Copy is self-contained here (clipboard + toast) because every
// card call site relies on that, unlike the compact badge which is always embedded
// in a surface that already owns a copy handler.

function IdentityCard({
  identity,
  walletLink,
  className,
}: {
  identity: WalletIdentity;
  walletLink: WalletLinkTarget;
  className?: string;
}) {
  const t = useTranslations();

  if (identity.state === "managed") {
    return (
      <CardShell className={className} testId="wallet-identity-card">
        <WalletProviderMark provider={identity.provider} />
        <div className="min-w-0 flex-1">
          {identity.provider ? (
            <CardEyebrow>{formatCustodyProviderName(identity.provider)}</CardEyebrow>
          ) : null}
          <WalletNameLink
            walletId={identity.walletId}
            target={walletLink}
            title={identity.name}
            className="text-[15px] leading-6 font-semibold tracking-[-0.1px] text-primary"
          >
            {identity.name}
          </WalletNameLink>
          <div className="mt-2.5 space-y-2">
            <CardKeyRow
              icon={Wallet}
              label={t("DashboardIssuance.wallet.walletId")}
              value={identity.walletId}
            />
            <CardKeyRow
              icon={KeyRound}
              label={t("DashboardIssuance.wallet.publicKey")}
              value={identity.publicKey}
            />
          </div>
        </div>
      </CardShell>
    );
  }

  if (identity.state === "none") {
    return (
      <CardShell className={className}>
        <WalletProviderMark provider={null} />
        <div className="min-w-0 flex-1">
          <CardTitle className="text-warning">
            {t("DashboardIssuance.overview.authorityNotSet")}
          </CardTitle>
        </div>
      </CardShell>
    );
  }

  if (identity.state === "default") {
    return (
      <CardShell className={className}>
        <WalletProviderMark provider={null} />
        <div className="min-w-0 flex-1">
          <CardTitle>{t("DashboardIssuance.overview.signerDefault")}</CardTitle>
          <p className="mt-1 text-sm leading-[1.45] text-secondary">
            {t("DashboardIssuance.overview.signerDefaultHint")}
          </p>
        </div>
      </CardShell>
    );
  }

  if (identity.state === "unresolved") {
    return (
      <CardShell className={className}>
        <CardWarningMark />
        <div className="min-w-0 flex-1">
          <CardTitle className="text-warning">
            {t("DashboardIssuance.overview.signerUnavailable")}
          </CardTitle>
          <div className="mt-2.5">
            <CardKeyRow
              icon={Wallet}
              label={t("DashboardIssuance.wallet.walletId")}
              value={identity.walletId}
            />
          </div>
        </div>
      </CardShell>
    );
  }

  // external / custom / unknown — a raw address; they differ only in what we can
  // say about who holds it.
  const isExternal = identity.state === "external";
  return (
    <CardShell className={className}>
      {isExternal ? <CardWarningMark /> : <WalletProviderMark provider={null} />}
      <div className="min-w-0 flex-1">
        <CardTitle className={isExternal ? "text-warning" : undefined}>
          {isExternal
            ? t("DashboardIssuance.overview.authorityExternal")
            : t("DashboardIssuance.wallet.customAddress")}
        </CardTitle>
        <div className="mt-2.5">
          <CardKeyRow
            icon={KeyRound}
            label={t("DashboardIssuance.wallet.publicKey")}
            value={identity.publicKey}
          />
        </div>
      </div>
    </CardShell>
  );
}

function CardShell({
  children,
  testId,
  className,
}: {
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        WALLET_HOVER_GROUP,
        "flex items-start gap-3 rounded-[12px] border border-border-default bg-fill-subtle px-4 py-3",
        className
      )}
    >
      {children}
    </div>
  );
}

// Matches WalletProviderMark's `md` footprint so a warning card lines up with a
// provider card in the same stack.
function CardWarningMark() {
  return (
    <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-warning-border bg-warning-bg text-warning">
      <TriangleAlert className="h-[22px] w-[22px]" />
    </div>
  );
}

function CardEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] leading-4 font-medium tracking-[0.06em] text-tertiary uppercase">
      {children}
    </p>
  );
}

function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "text-[15px] leading-6 font-semibold tracking-[-0.1px] text-primary",
        className
      )}
    >
      {children}
    </p>
  );
}

function CardKeyRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] leading-4 font-medium tracking-[0.04em] text-tertiary uppercase">
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </p>
      <div className="mt-1 flex items-center gap-0.5">
        <p className="min-w-0 break-all text-xs leading-5 text-primary">{value}</p>
        <CardCopyButton value={value} label={label} />
      </div>
    </div>
  );
}

function CardCopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("DashboardIssuance.wallet.copied", { label }));
    } catch {
      toast.error(t("DashboardIssuance.wallet.unableToCopy", { label }));
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      // `icon-xs` keeps the 24px button box; only the glyph inside it shrinks. The
      // size has to be spelled as `size-*`: the variant carries a
      // `[&_svg:not([class*='size-'])]:size-3` rule that would otherwise outrank it.
      size="icon-xs"
      className="shrink-0 text-tertiary"
      onClick={() => void handleCopy()}
      aria-label={t("DashboardIssuance.wallet.copy", { label })}
      title={t("DashboardIssuance.wallet.copy", { label })}
    >
      <Copy className="size-2.5" />
    </Button>
  );
}
