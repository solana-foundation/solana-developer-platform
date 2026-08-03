"use client";

import { Popover } from "@base-ui/react/popover";
import type { PaymentsDashboardWallet } from "@sdp/types";
import {
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronUp,
  Clock,
  Coins,
  Copy,
  ExternalLink,
  Hash,
  Info,
  type LucideIcon,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Signature,
  SlidersHorizontal,
  Terminal,
  UsersRound,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { AccessBadge, AssetOverviewHero, AuthoritiesGlyph, StatTile } from "./asset-overview-hero";
import {
  buildOverviewHeroData,
  deploymentStatusBadge,
  getDeploymentStatus,
  getTokenChips,
  type IssuanceTokenView,
  tokenExplorerHref,
} from "./issuance-token-fields";
import { WalletIdentityBadge } from "./wallet-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Composite-only reveal.
// A row's detail panel is rendered ABSOLUTELY (so it never contributes to layout)
// and pre-mounted for every row, then faded in/out with opacity. Opening a row
// pushes the rows below it by translating them with `transform` — never by
// relayout — so the motion is pure compositor work (no per-frame Layout/Paint,
// which profiling showed was the source of the dropped frames). Panels are
// measured up front so the slide starts on the click frame (no rAF / measure
// round-trip). Rows animate via `transform`; the browser promotes a row to a
// compositor layer for the duration of the transition on its own, so we do NOT
// pin a permanent `will-change: transform` — a persistent layer on every row
// regressed Safari/Firefox (they choke on many long-lived compositor layers),
// while transition-time promotion keeps the motion on the compositor everywhere.
// Supports multiple rows open at once: each row is offset by the summed height of
// every open panel above it.
// ─────────────────────────────────────────────────────────────────────────────

// Total budget for a toggle: the row slide runs the full duration, and every fade
// below is scaled to fit inside it.
const ANIM_MS = 220;
const ROW_GAP_PX = 10; // matches the flex `gap-2.5`

// The panel's fade is deliberately asymmetric with the row slide, because open and
// close want opposite things. Opening: hold, then fade in quickly, so the panel is
// essentially opaque by the time the sliding rows have uncovered it (instead of
// ghosting at ~50% mid-slide) — delay + duration exactly fill ANIM_MS. Closing: fade
// out fast with no delay (~48% of the slide), so the card — in particular its
// "Manage this asset" footer — is gone *before* the rows below sweep up over it.
// Neither fade ever outlives the slide.
const FADE_IN_MS = 140;
const FADE_IN_DELAY_MS = 80;
const FADE_OUT_MS = 105;

function detailHref(token: IssuanceTokenView): string {
  return `/dashboard/issuance/${token.id}`;
}

function TokenAvatar({ token, size = 40 }: { token: IssuanceTokenView; size?: number }) {
  const t = useTranslations();
  return (
    <div
      className="shrink-0 overflow-hidden rounded-full border border-border-default bg-fill-subtle"
      style={{ height: size, width: size }}
    >
      {token.imageUrl ? (
        // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
        <img
          src={token.imageUrl}
          alt={t("DashboardIssuance.workspace.tokenLogo", { name: token.name })}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-tertiary">
          {token.symbol.slice(0, 1) || "?"}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ token }: { token: IssuanceTokenView }) {
  const t = useTranslations();
  const { badge, label } = deploymentStatusBadge(getDeploymentStatus(token), t);
  return (
    <span
      data-testid={`token-row-status-${token.id}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize",
        badge
      )}
    >
      {label}
    </span>
  );
}

// Actions menu — Manage, playground deep-link, and quick actions. Copy uses the
// clipboard API. Reused by the list row and the grid tile, which differ only in the
// trigger's frame: ghost in the row, where the ⋯ ends a line of content, and outline
// in the tile's corner, where an unframed icon would float. The glyph itself is the
// same in both, because the menu behind it is — it's about the asset's actions, not
// about any one of them.
export function ManageKebab({
  token,
  triggerVariant = "ghost",
}: {
  token: IssuanceTokenView;
  triggerVariant?: "ghost" | "outline";
}) {
  const t = useTranslations();
  const explorer = tokenExplorerHref(token.mintAddress);
  const playgroundHref = `/dashboard/issuance?tab=playground&tokenId=${encodeURIComponent(token.id)}`;

  const handleCopyMintAddress = async () => {
    if (!token.mintAddress) return;
    try {
      await navigator.clipboard.writeText(token.mintAddress);
      toast.success(t("DashboardIssuance.list.copied"));
    } catch {
      toast.error(t("DashboardIssuance.list.unableToCopy"));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t("DashboardIssuance.workspace.manage")}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem asChild>
          <Link href={detailHref(token)}>
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
            {t("DashboardIssuance.workspace.manage")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={playgroundHref}>
            <Terminal className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
            {t("DashboardIssuance.playground.openInPlayground")}
          </Link>
        </DropdownMenuItem>
        {(explorer || token.mintAddress) && <DropdownMenuSeparator />}
        {explorer ? (
          <DropdownMenuItem asChild>
            <a href={explorer} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
              {t("DashboardIssuance.list.viewOnExplorer")}
            </a>
          </DropdownMenuItem>
        ) : null}
        {token.mintAddress ? (
          <DropdownMenuItem onSelect={() => void handleCopyMintAddress()}>
            <Copy className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
            {t("DashboardIssuance.list.copyMintAddress")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsedStat({
  icon: Icon,
  label,
  value,
  hint,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  /** Optional secondary fact revealed by an (i) affordance beside the label. */
  hint?: { label: string; value: string };
  className?: string;
}) {
  return (
    <div className={cn("hidden min-w-0 text-center lg:block", className)}>
      <p className="flex items-center justify-center gap-1 text-xs text-tertiary">
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
        {hint ? <StatHint hint={hint} /> : null}
      </p>
      <p className="mt-0.5 truncate text-sm font-normal text-primary">{value}</p>
    </div>
  );
}

// The (i) beside a collapsed-row stat. It needs `relative z-10` because the row's
// full-bleed toggle button is an `absolute inset-0 z-0` sibling that otherwise paints
// over the stats and swallows their pointer events — which is why a plain `title`
// attribute here would never fire. Clicking the icon therefore does not toggle the
// row; the rest of the row still does. Matches the AuthoritiesGlyph popover so the
// two hover surfaces in this feature look the same.
// Exported so the grid tile can carry the same (i) beside its date label — the
// workspace already reaches in here for ManageKebab.
export function StatHint({ hint }: { hint: { label: string; value: string } }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={100}
        closeDelay={140}
        aria-label={hint.label}
        onClick={(event) => event.stopPropagation()}
        // `p-0.5 -m-0.5` keeps the glyph subordinate to the label while giving the
        // hit area back the pixels the padding adds — the negative margin cancels it
        // out, so the icon takes exactly as much room in the label row as before.
        className="relative z-10 -m-0.5 inline-flex shrink-0 cursor-default items-center justify-center rounded-full p-0.5 text-tertiary outline-none transition-colors hover:text-secondary focus-visible:text-secondary"
      >
        <Info className="h-2.5 w-2.5" />
      </Popover.Trigger>
      <Popover.Portal>
        {/* Above the workspace's pinned header (z-20) — same reason as the authority
            popover: it opens upward from a scrolling row. */}
        <Popover.Positioner side="top" align="center" sideOffset={8} className="z-30">
          <Popover.Popup className="overflow-hidden rounded-xl border border-border-default bg-surface-raised outline-none">
            <div className="px-3 py-2 text-left text-[12px] leading-snug">
              <p className="text-tertiary">{hint.label}</p>
              <p className="mt-0.5 font-medium text-primary">{hint.value}</p>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function IssuanceTokenListRow({
  token,
  open,
  offset,
  zIndex,
  signerWallets,
  onToggle,
  onHeight,
}: {
  token: IssuanceTokenView;
  open: boolean;
  offset: number;
  /** Stacking rung — see the ladder built in `IssuanceTokenList`. */
  zIndex: number;
  signerWallets: PaymentsDashboardWallet[];
  onToggle: () => void;
  onHeight: (id: string, height: number) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const chips = getTokenChips(token, t);
  const panelRef = useRef<HTMLDivElement>(null);

  // Overview-hero tile data derived from the token row + org custody wallets;
  // memoized so re-renders (offset changes) don't recompute the authority glyph.
  const heroData = useMemo(
    () => buildOverviewHeroData(token, signerWallets, t, locale),
    [token, signerWallets, t, locale]
  );

  // Generic clipboard helper for the expanded card — mint address and signer key.
  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("DashboardIssuance.list.copied"));
    } catch {
      toast.error(t("DashboardIssuance.list.unableToCopy"));
    }
  };

  // The second tile follows the token's own state. Before deploy the signer IS the
  // decision — whichever custody wallet signs becomes the authorities on-chain — so it
  // earns a tile, and access control stays a footnote pill in the Authorities row.
  // After deploy the signer is determined rather than chosen (an operation is signed by
  // whatever wallet holds the authority it exercises), so the tile goes to access
  // control instead.
  const deployed = getDeploymentStatus(token) !== "draft";
  const signerBadge = heroData.signerWallet ? (
    <WalletIdentityBadge
      identity={heroData.signerWallet}
      onCopy={(value) => void handleCopy(value)}
    />
  ) : null;
  // Three type-specific fields: the card's other four tiles (Authorities, the
  // state-dependent second slot, Issuer name, and the first of these) fill its grid.
  const categoryTiles = heroData.categoryTiles.slice(0, 3);

  // Measure the (always-mounted) panel up front and keep it current, so the list
  // knows how far to push the rows below the instant a row is toggled.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) {
      return;
    }
    onHeight(token.id, el.offsetHeight);
    const observer = new ResizeObserver(() => onHeight(token.id, el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [token.id, onHeight]);

  // Compositor promotion for the fading panel. The panel is a tile-heavy hero;
  // without a layer hint Chrome animates its opacity on the main thread, repainting
  // the whole card every frame (janky with DevTools closed, masked while the profiler
  // forces continuous compositing — hence "nothing in the trace"). Two things matter:
  //
  //  * WHEN the hint lands. Driving it from `useEffect` applied it *after* paint, so
  //    an isolated toggle started un-promoted and Chrome re-rasterised mid-flight.
  //    That is why rapid clicking held 60fps (the previous toggle's hint was still
  //    live) while a single click after a pause dropped frames. `useLayoutEffect`
  //    lands it in the same frame the transition starts.
  //  * Pre-warming on hover. A pointer always enters the row before clicking it, so
  //    promoting there moves layer creation and raster off the click frame entirely.
  //
  // Applied imperatively rather than via state on purpose: rows sliding under a
  // stationary cursor fire pointerenter/leave mid-animation, and a re-render there
  // would cost the very frames this protects. The hint is always released once the
  // row is idle and unhovered — a permanent per-row layer regresses Safari/Firefox.
  const hoveredRef = useRef(false);
  const animatingRef = useRef(false);

  const promotePanel = useCallback(() => {
    const el = panelRef.current;
    if (el) {
      el.style.willChange = "opacity";
    }
  }, []);

  const releasePanel = useCallback(() => {
    const el = panelRef.current;
    if (el && !hoveredRef.current && !animatingRef.current) {
      el.style.willChange = "";
    }
  }, []);

  const toggleMountedRef = useRef(false);
  // Runs on every open/close toggle — including external ones such as "Collapse
  // all" — and reacts to `open` changing rather than reading its value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger-only dep
  useLayoutEffect(() => {
    if (!toggleMountedRef.current) {
      toggleMountedRef.current = true;
      return;
    }
    animatingRef.current = true;
    promotePanel();
    const timer = setTimeout(() => {
      animatingRef.current = false;
      releasePanel();
    }, ANIM_MS);
    return () => clearTimeout(timer);
  }, [open, promotePanel, releasePanel]);

  return (
    <div
      className="relative"
      style={{
        transform: `translateY(${offset}px)`,
        transition: `transform ${ANIM_MS}ms ease-out`,
        zIndex,
      }}
      // Pre-warm the panel's compositor layer while the pointer is over the row, so
      // the click frame has no layer creation or raster left to do.
      onPointerEnter={() => {
        hoveredRef.current = true;
        promotePanel();
      }}
      onPointerLeave={() => {
        hoveredRef.current = false;
        releasePanel();
      }}
    >
      <div
        data-testid={`token-row-${token.id}`}
        // Same hover affordance as the grid tiles: border-only, no fill change.
        // The open row keeps the default border so it reads as one unit with the
        // (default-bordered) panel below it.
        className="group overflow-hidden rounded-2xl border border-border-default bg-surface-raised transition-colors hover:border-primary/40"
      >
        <div
          className={cn(
            "relative grid items-center gap-x-3 p-4 text-left",
            "grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]",
            "md:grid-cols-[auto_auto_auto_minmax(0,1fr)_auto_auto]",
            "lg:grid-cols-[auto_auto_11rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_auto]"
          )}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={t("DashboardIssuance.list.toggleDetails", { name: token.name })}
            className="absolute inset-0 z-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)] focus-visible:ring-inset"
          />
          {/* The row-wide overlay above already toggles, but the chevron is the
              affordance people aim at — give it its own hit target and hover so
              it reads as the control it looks like. Sits above the overlay, and
              stays out of the tab order / a11y tree so the row exposes exactly
              one toggle instead of two identical ones. */}
          <button
            type="button"
            onClick={onToggle}
            tabIndex={-1}
            aria-hidden="true"
            className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-tertiary outline-none transition-colors group-hover:text-secondary hover:bg-fill hover:text-primary"
          >
            <ChevronDown
              className={cn("h-4 w-4 transition-transform duration-200", open && "rotate-180")}
              aria-hidden="true"
            />
          </button>
          <TokenAvatar token={token} />
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-tertiary">{token.symbol}</p>
            <p className="mt-0.5 truncate text-sm font-medium text-primary">{token.name}</p>
          </div>
          <div className="hidden min-w-0 flex-col items-start gap-1 md:flex">
            {chips.map((chip) => {
              const Icon = chip.icon;
              return (
                <span
                  key={chip.label}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle bg-fill-subtle px-2 py-0.5 text-xs text-secondary"
                >
                  {Icon ? (
                    <Icon className="h-3.5 w-3.5 shrink-0 text-tertiary" aria-hidden="true" />
                  ) : null}
                  <span className="truncate">{chip.label}</span>
                </span>
              );
            })}
          </div>
          <CollapsedStat
            icon={Coins}
            label={t("DashboardIssuance.workspace.supply")}
            value={heroData.supply}
          />
          {/* Decimals stays in the row on purpose: a column is scanned vertically, so
              its cells have to be the same fact for every asset. A per-asset field
              here would give each row a different label — informative once, unscannable
              as a column. The grid tile has no column to keep, so that is where the
              asset's own data goes. */}
          <CollapsedStat
            icon={Hash}
            label={t("DashboardIssuance.list.decimals")}
            value={String(token.decimals)}
          />
          {/* Smart date: the deploy date once deployed, the created date while a
              draft. A deployed token carries the draft-created date in the (i)
              alongside, so the other date stays reachable without a second tile. */}
          <CollapsedStat
            icon={Clock}
            label={heroData.date.label}
            value={heroData.date.value}
            hint={heroData.secondaryDate ?? undefined}
          />
          <div className="flex justify-end">
            <StatusBadge token={token} />
          </div>
          <div className="relative z-10 flex justify-end">
            <ManageKebab token={token} />
          </div>
        </div>
      </div>

      {/* Pre-mounted, absolutely-positioned panel. Absolute → no layout impact;
          the rows below make room by translating. Fades with opacity (compositor)
          and never paints while closed. The shared Overview hero renders its own
          card, so this wrapper is positioning-only.
          `inert` while closed is load-bearing: the panel stays in the DOM, so its
          explorer links and Manage link would otherwise stay tabbable and land
          keyboard users on invisible controls (opacity/pointer-events suppress
          neither). inert removes the subtree from sequential focus, hit testing,
          and the accessibility tree in one go — which is also why it carries no
          aria-hidden: that would hide the subtree from AT while leaving it
          focusable. */}
      <div
        ref={panelRef}
        inert={!open}
        className="absolute inset-x-0"
        style={{
          top: `calc(100% + ${ROW_GAP_PX}px)`,
          opacity: open ? 1 : 0,
          transition: open
            ? `opacity ${FADE_IN_MS}ms ease-out ${FADE_IN_DELAY_MS}ms`
            : `opacity ${FADE_OUT_MS}ms ease-out`,
          pointerEvents: open ? "auto" : "none",
          // `will-change` is intentionally absent here — it is driven imperatively
          // (see promotePanel/releasePanel) so React never rewrites it.
        }}
      >
        <AssetOverviewHero
          description={heroData.description}
          website={heroData.website}
          mintAddress={heroData.mintAddress}
          onCopyMintAddress={(value) => void handleCopy(value)}
          tiles={
            <>
              {/* Supply, decimals, status and the primary date all live in the
                  collapsed row — the card never repeats them. Its date slot instead
                  carries the *other* date (when a deployed token was drafted), which
                  only exists once deployed. */}
              {/* `framed` on both: object values, side by side — see StatTile. */}
              {/* "Control" while the policy pills are in here with the marks — the tile
                  states who holds the authorities AND who may hold the asset, which is
                  more than "Authorities" claims. Once deployed the pills move to their
                  own tile and the label narrows back to what is left. */}
              <StatTile
                icon={ShieldCheck}
                label={t(
                  deployed
                    ? "DashboardIssuance.overview.authorities"
                    : "DashboardIssuance.overview.control"
                )}
                framed
                value={
                  <AuthoritiesGlyph
                    rows={heroData.authorityRows}
                    accessMode={heroData.accessMode}
                    verifiedHolders={heroData.verifiedHolders}
                    deployed={deployed}
                    onCopy={(value) => void handleCopy(value)}
                    // Cross-route from the list, so a real link.
                    permissionsHref={`${detailHref(token)}?tab=permissions`}
                  />
                }
              />
              {/* The second slot: who will sign for a draft, who may hold once
                  deployed. See `deployed` above for why they trade places. */}
              {deployed ? (
                <StatTile
                  // Who may hold the asset — neutral on purpose. A list glyph here
                  // reads as "allowlist" before the value has said so, and the tile
                  // also has to head "Blocklist" and "Unrestricted".
                  icon={UsersRound}
                  label={t("DashboardIssuance.summary.accessControl")}
                  framed
                  value={
                    <AccessBadge
                      mode={heroData.accessMode}
                      verifiedHolders={heroData.verifiedHolders}
                      standalone
                    />
                  }
                />
              ) : (
                <StatTile
                  icon={Signature}
                  label={t("DashboardIssuance.overview.signerWallet")}
                  framed
                  value={signerBadge}
                />
              )}
              {heroData.issuer ? (
                <StatTile
                  icon={Building2}
                  label={t("DashboardIssuance.config.issuerName")}
                  value={heroData.issuer}
                  clamp
                />
              ) : null}
              {categoryTiles.map((tile) => (
                <StatTile
                  key={tile.label}
                  icon={tile.icon}
                  label={tile.label}
                  value={tile.value}
                  clamp
                />
              ))}
            </>
          }
          footer={
            // Close sits opposite the primary action rather than floating over the
            // card: framed by the footer row, labelled, and unambiguous — an
            // unlabelled ✕ on a record reads as "remove this asset". It is styled to
            // recede (muted, regular weight) so it never competes with "Manage this
            // asset"; hover and keyboard focus bring it back up to full contrast.
            <div className="flex w-full items-center justify-between gap-3">
              <button
                type="button"
                onClick={onToggle}
                tabIndex={open ? undefined : -1}
                aria-label={t("DashboardIssuance.list.closeDetails", { name: token.name })}
                className="-ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-normal text-muted outline-none transition-colors hover:bg-fill hover:text-secondary focus-visible:text-secondary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]"
              >
                <ChevronUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t("DashboardIssuance.list.close")}
              </button>
              <Link
                href={detailHref(token)}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                {t("DashboardIssuance.list.manageThisAsset")}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          }
        />
      </div>
    </div>
  );
}

export function IssuanceTokenList({
  tokens,
  signerWallets,
  openIds,
  onToggle,
  onCreate,
  footer,
}: {
  tokens: IssuanceTokenView[];
  signerWallets: PaymentsDashboardWallet[];
  // Which rows are expanded. Owned by the workspace — its pinned header carries
  // the expand/collapse-all control; this component stays in charge of the motion.
  openIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onCreate: () => void;
  // Rendered below the add-row button and displaced with it. Anything that has to
  // sit under the list belongs here rather than after it: because open panels are
  // absolute and the rows below them only translate, this component's own box
  // never grows, so an outside sibling would stay where the collapsed list left it.
  footer?: ReactNode;
}) {
  const t = useTranslations();
  const [heights, setHeights] = useState<Record<string, number>>({});

  const handleHeight = useCallback((id: string, height: number) => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }));
  }, []);

  // Each row is pushed down by the total height of every open panel above it.
  let running = 0;
  const rows = tokens.map((token) => {
    const open = openIds.has(token.id);
    const offset = running;
    if (open) {
      running += (heights[token.id] ?? 0) + ROW_GAP_PX;
    }
    return { token, open, offset };
  });
  const totalOffset = running;

  return (
    // No scroll-space reservation: the transformed rows/button already grow the
    // scroll container's scrollHeight on their own (scrollable overflow includes
    // transformed content), keeping displaced content reachable in Chrome, Safari,
    // and Firefox.
    //
    // Firefox does reflow that overflow every animation frame, so its *open* slide
    // janks. Front-loading the reflow with an instant `paddingBottom` fixes
    // Firefox's open — but forces a reflow Chrome/Safari don't need and measurably
    // regressed Safari, so we don't. Safari smoothness wins over Firefox's; the
    // residual Firefox jank is accepted.
    <div className="relative isolate flex flex-col gap-2.5">
      {/* `isolate` keeps the ladder below a stacking context of its own, so its rungs
          (0..tokens.length) can't compete with the workspace's pinned header or with
          portalled popups — without it the header would need a z above the page size.

          Static stacking ladder: each row sits one rung above the row before it, so
          a row's card ALWAYS occludes the panel hanging beneath the rows above it —
          the panel is revealed from behind the sliding rows. It's deliberately a
          function of position, not of `open`: the previous `open ? 0 : 1` flipped
          the instant a row was toggled while the motion still had ANIM_MS to run, so
          mid-animation a closing panel could paint over a still-open row below
          (its footer visibly overlapping the neighbouring card). */}
      {rows.map(({ token, open, offset }, index) => (
        <IssuanceTokenListRow
          key={token.id}
          token={token}
          open={open}
          offset={offset}
          zIndex={index}
          signerWallets={signerWallets}
          onToggle={() => onToggle(token.id)}
          onHeight={handleHeight}
        />
      ))}
      <button
        type="button"
        onClick={onCreate}
        data-testid="token-add-row"
        className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised py-3.5 text-sm font-medium text-tertiary transition-colors hover:border-primary/40 hover:text-secondary"
        style={{
          transform: `translateY(${totalOffset}px)`,
          transition: `transform ${ANIM_MS}ms ease-out`,
          // Top rung of the ladder — it sits below every row, so it must paint above
          // the last row's panel as that panel slides out from under it.
          zIndex: tokens.length,
        }}
      >
        <Plus className="h-4 w-4" />
        {t("DashboardIssuance.workspace.createDraft")}
      </button>
      {/* Rides the same displacement as the add-row button above it, on the same
          easing, so the list and its pager move as one piece. Shares the top rung
          of the ladder for the same reason the button does: the last row's panel
          has to slide out from under it, not over it.
          The negative margin cancels the flex `gap-2.5`, leaving whatever spacing
          the footer brings itself — the pager then sits exactly where it does in
          grid view, where it's an ordinary sibling of the card grid. */}
      {footer ? (
        <div
          style={{
            marginTop: -ROW_GAP_PX,
            transform: `translateY(${totalOffset}px)`,
            transition: `transform ${ANIM_MS}ms ease-out`,
            zIndex: tokens.length,
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
