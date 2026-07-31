"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Coins,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { cn } from "@/lib/utils";
import { AuthoritiesGlyph } from "./asset-overview-hero";
import { CreateIssuanceTokenModal } from "./create-token-modal";
import { IssuanceFilterPopover } from "./issuance-filter-popover";
import { IssuanceLegacyOverview } from "./issuance-legacy-overview";
import type { IssuanceFilterState, IssuanceListQuery } from "./issuance-list-query";
import { IssuanceListSkeleton } from "./issuance-list-skeleton";
import { IssuancePlaygroundLoading } from "./issuance-playground-loading";
import {
  buildOverviewHeroData,
  buildSmartDate,
  deploymentStatusBadge,
  formatSupply,
  getDeploymentStatus,
  getTokenChips,
  getTokenTypeLabel,
  type IssuanceTokenView,
  tokenMarkInitial,
} from "./issuance-token-fields";
import { IssuanceTokenList, ManageKebab, StatHint } from "./issuance-token-list";
import type { TokenView } from "./issuance-token-view";
import type { IssuanceTokenFacets } from "./issuance-tokens.data";
import { useIssuancePlaygroundTokens, useIssuanceTokenList } from "./use-issuance-token-list";

// Full-page draft wizard when the Asset Profiles UI flag is on; the legacy
// create-token-modal.tsx handles creation when it's off.
const CREATE_DRAFT_PATH = "/dashboard/issuance/create";

const IssuancePlayground = dynamic(
  () => import("./issuance-playground").then((module) => module.IssuancePlayground),
  {
    loading: () => <IssuancePlaygroundLoading />,
  }
);

interface IssuanceApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface IssuanceTemplateOption {
  id: string;
  name: string;
  description?: string;
}

interface IssuanceWorkspaceProps {
  assetProfilesEnabled: boolean;
  /** List state parsed from the URL — the request the server already answered. */
  initialQuery: IssuanceListQuery;
  /** The page the server rendered, reused as SWR's fallback for that same query. */
  initialTokens: IssuanceTokenView[];
  /** Rows matching `initialQuery` (not the project total — that's `facets.total`). */
  initialTotal: number;
  facets: IssuanceTokenFacets;
  templates: IssuanceTemplateOption[];
  apiKeys: IssuanceApiKeyOption[];
  signerWallets: PaymentsDashboardWallet[];
  apiBaseUrl: string | null;
  templatesError: string | null;
  tokensNotice: string | null;
  signerWalletsError: string | null;
}

// Grid ⇄ list cross-fade. Matches the workspace tab-shell transition so the two
// views dissolve into each other rather than hard-swapping. `mode="wait"` lets
// the outgoing layout leave before the (differently-sized) incoming one mounts,
// avoiding a stacked-height jump mid-animation.
const viewTransition = { duration: 0.18, ease: "easeOut" } as const;

// Classes for the scrolling overview panel (the tab shell's `overflow-y-auto` div —
// the shell locks the viewport, so that inner panel is what actually scrolls).
//
// `overflow-anchor: none` is deliberate. Expanding a list row grows the scroll extent
// (transformed overflow counts toward scrollHeight) and collapsing shrinks it again.
// Chrome's scroll anchoring reacts to that extent change by reconciling scrollTop —
// a discrete layout hit that showed up as an intermittent stutter on collapse, and
// disabling it measurably smoothed the close. Anchoring exists to stop content from
// jumping when something above the viewport resizes asynchronously; this list only
// ever resizes in direct response to a click, so there is nothing here for it to
// protect and we pay the cost for no benefit. Scoped to issuance rather than added
// to the shared panel class so other dashboard surfaces keep the default behaviour.
// `pt-0` hands the panel's top padding to the pinned header below, so the header
// keeps its breathing room once it is stuck to the top of the scrollport.
const ISSUANCE_OVERVIEW_PANEL_CLASS = "pt-0 [overflow-anchor:none]";

// The pinned header (toolbar + asset count) sits in the scroll flow and sticks to
// the top, so cards pass *behind* it — which only works with an opaque backdrop.
// The scrolling panel's own backdrop is the shell's `--surface` seen through the
// content section's `bg-surface-raised/80`; alpha compositing is a plain sRGB mix,
// so this color-mix reproduces that composite exactly, in both themes.
const PINNED_HEADER_BG =
  "color-mix(in srgb, var(--color-surface-raised) 80%, var(--color-surface))";

// That backdrop is painted as a gradient rather than a flat fill: solid down to the
// asset-count row, then out to transparent over this band. A flat fill guillotines
// what scrolls under it — a row's top border and its badges were being cut mid-stroke
// at a hard horizontal line — whereas the fade dissolves them. The band sits entirely
// inside the header's bottom padding, below every child, so nothing in the header is
// ever painted on a see-through backdrop; and at rest it fades over the same composite
// color it starts from, so it is invisible until something scrolls behind it.
//
// Keep in step with the header's `pb-*`: the two are the same length (see the class).
// That coupling is also the ceiling on how long the fade can be — the band cannot hang
// below the header's box, because at rest the box's bottom edge is exactly the first
// row's top edge, and the header paints above the rows (z-20). Any overhang would
// wash out that row's top border while it is sitting still. So the fade is as long as
// the gap under the asset-count row and no longer; smoothstep is what buys the
// remaining softness back at this length.
const PINNED_HEADER_FADE_PX = 12;

// A *linear* alpha ramp still reads as an edge. Alpha falls fastest right where the
// band begins, so the eye catches that kink and resolves it as a line — the very
// artifact the fade exists to remove. These stops sample smoothstep (3t² − 2t³)
// instead: the ramp leaves full opacity and arrives at full transparency with zero
// slope, so both ends of the band blend into what they meet. Generated rather than
// hand-written as an arbitrary-value class — nine nested color-mix stops make for an
// unreadable class name, and inline keeps it one static string.
function buildPinnedHeaderBackdrop(): string {
  const segments = 8;
  const stops = Array.from({ length: segments + 1 }, (_, index) => {
    const t = index / segments;
    const alpha = 1 - (3 * t * t - 2 * t * t * t);
    const fromBottom = PINNED_HEADER_FADE_PX * (1 - t);
    return `color-mix(in srgb, ${PINNED_HEADER_BG} ${(alpha * 100).toFixed(2)}%, transparent) calc(100% - ${fromBottom.toFixed(2)}px)`;
  });
  return `linear-gradient(to bottom, ${PINNED_HEADER_BG} 0, ${stops.join(", ")})`;
}

const PINNED_HEADER_STYLE = { backgroundImage: buildPinnedHeaderBackdrop() } as const;

// One asset tile in the grid view. Its own component so the workspace function
// stays readable — and so the grid's per-token derivations sit next to the markup
// that uses them.
function IssuanceTokenGridCard({
  token,
  signerWallets,
  t,
  locale,
}: {
  token: IssuanceTokenView;
  signerWallets: PaymentsDashboardWallet[];
  t: ReturnType<typeof useTranslations>;
  locale: ReturnType<typeof useLocale>;
}) {
  const deploymentStatus = getDeploymentStatus(token);
  const deployed = deploymentStatus !== "draft";
  const chips = getTokenChips(token, t);
  const smartDate = buildSmartDate(token, t, locale);
  // The same hero derivation the list's expanded card runs — the tile only reads its
  // authority rows, access mode and signer off it. Memoized because the workspace
  // re-renders this card on every keystroke in the search box.
  const heroData = useMemo(
    () => buildOverviewHeroData(token, signerWallets, t, locale),
    [token, signerWallets, t, locale]
  );

  return (
    <article
      key={token.id}
      data-testid={`token-card-${token.id}`}
      className="relative flex min-h-[240px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5 transition-colors hover:border-primary/40"
    >
      {/* Full-bleed overlay link makes the whole tile navigate; the
          kebab sits above it (z-10) so its menu stays clickable. */}
      <Link
        href={`/dashboard/issuance/${token.id}`}
        aria-label={t("DashboardIssuance.workspace.manageAsset", {
          name: token.name,
        })}
        className="absolute inset-0 z-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)] focus-visible:ring-inset"
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-border-default bg-fill-subtle">
            {token.imageUrl ? (
              // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
              <img
                src={token.imageUrl}
                alt={t("DashboardIssuance.workspace.tokenLogo", {
                  name: token.name,
                })}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-tertiary">
                {tokenMarkInitial(token.symbol)}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-tertiary">{token.symbol}</p>
            <h3 className="mt-0.5 truncate text-lg font-medium leading-tight text-primary">
              {token.name}
            </h3>
          </div>
        </div>
        <span
          data-testid={`token-card-status-${token.id}`}
          className={cn(
            "inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize",
            deploymentStatusBadge(deploymentStatus, t).badge
          )}
        >
          {deploymentStatusBadge(deploymentStatus, t).label}
        </span>
      </div>

      {chips.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
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
      ) : null}

      {/* Control shares the first row with Supply, deliberately lopsided: it holds at
          least half the row and never shrinks, so its marks and policy pills always have
          the width they need, and past that it takes only what its own content asks for.
          Whatever is left goes to Supply, which is why its column no longer ends up
          pinned to the card's right edge. The date keeps the bottom row with the kebab,
          so the tile reads identity → classification → control → when. */}
      <div className="mt-6 flex items-start gap-x-5">
        <div className="min-w-[50%] shrink-0">
          {/* "Control", not "Authorities": this tile keeps the policy pills in the
              marks row at every state (it has no second tile to promote them into), so
              the slot always states more than who holds the authorities. */}
          <p className="flex items-center gap-1 text-xs text-tertiary">
            <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("DashboardIssuance.overview.control")}</span>
          </p>
          {/* A row of marks is a box, not a line of text, so it needs the ~6px of
              optical air text gets free from its half-leading — same rule as the
              hero's `framed` tiles. `relative z-10` keeps the marks above the tile's
              full-bleed overlay link, which would otherwise swallow their popovers. */}
          <div className="relative z-10 mt-1.5">
            <AuthoritiesGlyph
              rows={heroData.authorityRows}
              accessMode={heroData.accessMode}
              verifiedHolders={heroData.verifiedHolders}
              deployed={deployed}
              // The tile has no policy tile to promote the pills into, so they stay in
              // the marks row for deployed tokens too.
              keepAccessBadge
              // Cross-route from the grid, so a real link.
              permissionsHref={`/dashboard/issuance/${token.id}?tab=permissions`}
            />
          </div>
        </div>
        {/* Supply takes the rest of the row. Its text never wraps — a compact supply is
            short by construction — so the extra width is breathing room, not filler. */}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 whitespace-nowrap text-xs text-tertiary">
            <Coins className="h-3 w-3 shrink-0" aria-hidden="true" />
            {t("DashboardIssuance.workspace.supply")}
          </p>
          <p className="mt-0.5 whitespace-nowrap text-sm font-normal text-primary">
            {formatSupply(token.totalSupply, locale)}
          </p>
        </div>
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 pt-6">
        <div className="min-w-0">
          {/* Smart date, same rule as the list row: the deploy date once deployed, with
              the draft-created date behind the (i) so both stay reachable from one
              cell. */}
          <p className="flex items-center gap-1 text-xs text-tertiary">
            <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{smartDate.label}</span>
            {smartDate.hint ? <StatHint hint={smartDate.hint} /> : null}
          </p>
          <p className="mt-0.5 truncate text-sm font-normal text-primary">{smartDate.value}</p>
        </div>
        <div className="relative z-10">
          <ManageKebab token={token} triggerVariant="outline" />
        </div>
      </div>
    </article>
  );
}

// The results area: placeholders, the list, or the grid — one of the three.
//
// Extracted from the workspace so the loading branches don't push that function
// over the complexity budget, and so the two views' loading behaviour is decided
// in one place.
function IssuanceResults({
  view,
  reduceMotion,
  isLoadingNewResults,
  isLoadingAnotherPage,
  skeletonCount,
  tokens,
  signerWallets,
  openTokenIds,
  onToggleRow,
  onCreate,
  pagination,
  t,
  locale,
}: {
  view: TokenView;
  reduceMotion: boolean;
  isLoadingNewResults: boolean;
  isLoadingAnotherPage: boolean;
  skeletonCount: number;
  tokens: IssuanceTokenView[];
  signerWallets: PaymentsDashboardWallet[];
  openTokenIds: ReadonlySet<string>;
  onToggleRow: (id: string) => void;
  onCreate: () => void;
  pagination: ReactNode;
  t: ReturnType<typeof useTranslations>;
  locale: ReturnType<typeof useLocale>;
}) {
  const grid = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tokens.map((token) => (
        <IssuanceTokenGridCard
          key={token.id}
          token={token}
          signerWallets={signerWallets}
          t={t}
          locale={locale}
        />
      ))}

      <button
        type="button"
        onClick={onCreate}
        data-testid="token-add-card"
        className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised text-tertiary transition-colors hover:border-primary/40 hover:text-secondary"
      >
        <Plus className="h-6 w-6" />
        <span className="text-sm font-medium">{t("DashboardIssuance.workspace.addNewToken")}</span>
      </button>
    </div>
  );

  return (
    <>
      {/* One announcement for every kind of load, so a screen reader hears that the
          list is working whether the rows were replaced or only dimmed. */}
      <span className="sr-only" role="status" aria-live="polite">
        {isLoadingNewResults || isLoadingAnotherPage
          ? t("DashboardIssuance.workspace.loadingAssets")
          : ""}
      </span>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={viewTransition}
          // Paging keeps the rows on screen (keepPreviousData) because they are a
          // neighbouring slice of the same list; the dim is what marks them as the
          // previous ones. A new result set gets placeholders instead — those rows
          // answer a question that is no longer being asked.
          aria-busy={isLoadingNewResults || isLoadingAnotherPage}
          className={isLoadingAnotherPage ? "opacity-60 transition-opacity" : "transition-opacity"}
        >
          {isLoadingNewResults ? (
            <IssuanceListSkeleton view={view} count={skeletonCount} />
          ) : view === "list" ? (
            <IssuanceTokenList
              tokens={tokens}
              signerWallets={signerWallets}
              openIds={openTokenIds}
              onToggle={onToggleRow}
              onCreate={onCreate}
              // Handed to the list rather than rendered after it: expanding a row
              // displaces the rows by transform without growing the list's box, so a
              // pager outside it would be left stranded mid-list under the panel.
              // Inside, it rides the same displacement.
              footer={pagination}
            />
          ) : (
            grid
          )}
        </motion.div>
      </AnimatePresence>

      {/* Grid view only — cards don't expand, so the pager can simply follow the
          grid. In list view it lives inside IssuanceTokenList (see `footer`), and
          while placeholders are up there is no pager: its range would describe the
          result set being replaced. */}
      {view === "list" || isLoadingNewResults ? null : pagination}
    </>
  );
}

export function IssuanceWorkspace({
  assetProfilesEnabled,
  initialQuery,
  initialTokens,
  initialTotal,
  facets,
  templates,
  apiKeys,
  apiBaseUrl,
  templatesError,
  tokensNotice,
  signerWallets,
  signerWalletsError,
}: IssuanceWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const {
    issuanceTab,
    issuanceTokenView: view,
    setIssuanceTokenView,
    selectedPlaygroundApiKeyId,
    setPlaygroundApiKeys,
  } = useDashboardWorkspace();
  const router = useDashboardRouter();
  const [isCreateTokenModalOpen, setIsCreateTokenModalOpen] = useState(false);
  const isPlaygroundTab = issuanceTab === "playground";

  // Search, filters, sort and paging are one server-side query; the hook owns it,
  // mirrors it into the URL, and hands back the page it resolves to.
  const {
    query,
    search,
    setSearch,
    updateQuery,
    clearFilters,
    tokens,
    total,
    pageCount,
    rangeStart,
    rangeEnd,
    isFiltered,
    isInitialLoading,
    isRefreshing,
    isLoadingNewResults,
    isLoadingAnotherPage,
    isSearchPending,
    errorMessage: listFetchError,
  } = useIssuanceTokenList({ initialQuery, initialTokens, initialTotal });
  const listErrorMessage = listFetchError ? t("DashboardIssuance.errors.unableToLoadTokens") : null;
  // Unfiltered project count: what separates "no assets yet" from "no matches".
  const hasTokens = facets.total > 0;
  // The playground's picker must see the project, not the filtered page; falls
  // back to the visible rows so it is never empty while loading.
  const playgroundTokens = useIssuancePlaygroundTokens(isPlaygroundTab) ?? tokens;

  const reduceMotion = useReducedMotion();

  // Expanded list rows. Held here rather than in IssuanceTokenList because
  // expand-all works off the filtered set, which lives in this component.
  const [openTokenIds, setOpenTokenIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTokenRow = useCallback((id: string) => {
    setOpenTokenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const collapseAllTokenRows = useCallback(() => setOpenTokenIds(new Set()), []);

  // The view itself is owned by the workspace context (seeded from a cookie so the
  // server paints the right one — see issuance-token-view.ts); only the expanded
  // rows are local. The list unmounts on a view switch and re-measures its panels
  // on mount, so carrying them across would replay the slide. Start collapsed.
  const changeView = (next: TokenView) => {
    setIssuanceTokenView(next);
    collapseAllTokenRows();
  };

  // Asset Profiles UI flag: on → full-page wizard; off → legacy modal.
  const startTokenCreation = () => {
    if (assetProfilesEnabled) {
      router.push(CREATE_DRAFT_PATH);
      return;
    }
    setIsCreateTokenModalOpen(true);
  };

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

  useEffect(() => {
    if (isPlaygroundTab) {
      return;
    }

    const preloadPlayground = () => {
      void import("./issuance-playground");
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preloadPlayground);
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(preloadPlayground, 600);
    return () => globalThis.clearTimeout(timeoutId);
  }, [isPlaygroundTab]);

  const selectedPlaygroundApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId) ?? null,
    [apiKeys, selectedPlaygroundApiKeyId]
  );
  const selectedPlaygroundApiKeyPrefix = selectedPlaygroundApiKey?.keyPrefix ?? null;
  const playgroundApiKeyValue = useMemo(() => {
    if (!selectedPlaygroundApiKey) {
      return "";
    }

    const stored = getStoredApiKeySecret({
      apiKeyId: selectedPlaygroundApiKey.id,
      keyPrefix: selectedPlaygroundApiKeyPrefix,
    });

    return stored ?? "";
  }, [selectedPlaygroundApiKey, selectedPlaygroundApiKeyPrefix]);

  // Template options for the filter popover. Sourced from the project-wide facet
  // counts rather than the loaded rows, so the choices don't shrink to whatever
  // happens to be on the current page.
  const templateOptions = useMemo(() => {
    return facets.templates
      .map(({ template }) => ({ value: template, label: getTokenTypeLabel(template, t) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [facets.templates, t]);

  const updateFilters = useCallback(
    (changes: Partial<IssuanceFilterState>) => updateQuery(changes),
    [updateQuery]
  );

  // Which way the expand/collapse-all control points. Counts only rows that are on
  // screen, so an expanded row on another page can't leave the control claiming
  // "collapse" with nothing visibly open.
  const hasOpenTokenRows = tokens.some((token) => openTokenIds.has(token.id));
  // Expand-all covers the current page — the rows you can see are the rows it opens.
  const expandAllTokenRows = () => setOpenTokenIds(new Set(tokens.map((token) => token.id)));

  const playgroundContent = (
    <IssuancePlayground
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={playgroundApiKeyValue}
      hasActiveApiKeys={apiKeys.length > 0}
      templates={templates}
      templatesError={templatesError}
      tokens={playgroundTokens}
    />
  );

  // Shared pager. Stays live during a fetch: the arrows only ever move `page`, and
  // the rendered rows follow whichever page is current, so a second click while
  // the first is still in flight lands on the right page instead of being
  // swallowed. Bounds are the only thing that disables an arrow.
  const pagination =
    pageCount > 1 ? (
      <ArrowPagination
        className="mt-4"
        page={query.page}
        pageCount={pageCount}
        onPageChange={(page) => updateQuery({ page })}
        summary={t("DashboardIssuance.pagination.range", {
          start: rangeStart,
          end: rangeEnd,
          total,
        })}
      />
    ) : null;

  // How many placeholders to stand in for the rows. Matching what's on screen keeps
  // the page roughly its current height, so the swap doesn't move the scroll
  // position; a handful covers a first load with nothing to match.
  const skeletonCount = Math.min(tokens.length || 6, query.pageSize);

  // Empty results read differently depending on why: an over-filtered list needs
  // "no matches", a project with no assets at all needs its create affordances.
  // Never while loading — "no assets match" is a verdict, and the query answering
  // it hasn't come back yet.
  const emptyResultsNotice =
    !isInitialLoading &&
    !isLoadingNewResults &&
    tokens.length === 0 &&
    hasTokens &&
    !listErrorMessage ? (
      <p className="mb-4 text-sm text-secondary">
        {t(
          isFiltered
            ? "DashboardIssuance.workspace.noTokensMatch"
            : "DashboardIssuance.workspace.noTokensOnPage"
        )}
      </p>
    ) : null;

  // Legacy overview when the Asset Profiles UI flag is off.
  if (!assetProfilesEnabled) {
    return (
      <DashboardWorkspaceTabShell
        overviewClassName="space-y-6"
        overviewKey="tokens-tab"
        overview={
          <IssuanceLegacyOverview
            tokens={tokens}
            search={search}
            onSearchChange={setSearch}
            onCreate={startTokenCreation}
            isRefreshing={isRefreshing}
            tokensNotice={tokensNotice}
            emptyResultsNotice={emptyResultsNotice}
            pagination={pagination}
            createModal={
              <CreateIssuanceTokenModal
                open={isCreateTokenModalOpen}
                onOpenChange={setIsCreateTokenModalOpen}
                signerWallets={signerWallets}
                signerWalletsError={signerWalletsError}
                hideTrigger
              />
            }
          />
        }
        playground={playgroundContent}
      />
    );
  }

  return (
    <DashboardWorkspaceTabShell
      overviewClassName={ISSUANCE_OVERVIEW_PANEL_CLASS}
      overviewKey="tokens-tab"
      overview={
        <>
          {/* Pinned header — same in both views. Negative margins bleed the backdrop
              across the panel's horizontal padding so nothing shows through at the
              edges as content scrolls behind it.

              Issuance z ladder: header z-20 < this feature's popovers z-30 < the DS
              popup layer z-50 (Select, DropdownMenu, Combobox, Modal — all portalled
              to body). Keeping the whole ladder under 50 is what lets a Select opened
              inside the filter popover paint above that popover's panel, and a row
              kebab menu paint above this header. The list's per-row rungs stay out of
              the comparison because the list isolates them (see IssuanceTokenList). */}
          <div
            // `pb-3` == PINNED_HEADER_FADE_PX: the fade owns the whole bottom padding
            // and nothing more, so the asset-count row and the expand/collapse control
            // sit close to the rows they label. Smoothstep holds the band near-opaque
            // through its first few px, so that row still reads as being on solid
            // backdrop without reserving separate air for it.
            className="sticky top-0 z-20 -mx-3 space-y-4 px-3 pt-6 pb-3 md:-mx-6 md:px-6"
            style={PINNED_HEADER_STYLE}
          >
            {tokensNotice && tokens.length > 0 ? (
              <div className="rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
                <p className="text-sm font-medium text-primary">
                  {t("DashboardIssuance.workspace.tokenListUnavailable")}
                </p>
                <p className="mt-1 text-sm text-secondary">{tokensNotice}</p>
              </div>
            ) : null}

            {/* Toolbar: stacks into two rows below sm, one row from sm up. The
              breakpoint is the viewport, not the toolbar width — at ≥sm the sidebar
              is hidden below xl, so even iPad portrait has room for a single row. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3 sm:flex-1">
                <div className="flex-1">
                  <Input
                    value={search}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSearch(value);
                    }}
                    // The DS input paints its border on an inner span via
                    // --input-border-*, so border-* classes are inert — override the
                    // vars to 1px + shared tokens to match the filter/toggle buttons.
                    className="h-10 rounded-[10px] bg-surface-raised [--input-border-hover:var(--color-border-strong)] [--input-border-idle:var(--color-border-default)] [--input-border-width:1px]"
                    placeholder={t("DashboardIssuance.workspace.search")}
                    iconLeft={<Search />}
                    // Keystrokes are debounced and answered by the server, so the
                    // input says so — otherwise typing has no acknowledgement at
                    // all until the rows change.
                    iconRight={
                      isSearchPending ? (
                        <Loader2 className="animate-spin" aria-hidden="true" />
                      ) : null
                    }
                  />
                </div>
                {/* Filter & sort — icon-only trigger opening a popover. */}
                <IssuanceFilterPopover
                  filters={query}
                  onChange={updateFilters}
                  onClear={clearFilters}
                  templateOptions={templateOptions}
                />
                {/* Grid ⇄ list toggle — icon shows the view it switches to (grid
                  shows the list icon, and vice versa). */}
                <button
                  type="button"
                  aria-label={t(
                    view === "grid"
                      ? "DashboardIssuance.workspace.viewSwitchToList"
                      : "DashboardIssuance.workspace.viewSwitchToGrid"
                  )}
                  onClick={() => changeView(view === "grid" ? "list" : "grid")}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-border-default bg-surface-raised text-secondary outline-none transition-colors hover:border-border-strong hover:text-primary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]"
                >
                  {view === "grid" ? (
                    <List className="h-4 w-4" />
                  ) : (
                    <LayoutGrid className="h-4 w-4" />
                  )}
                </button>
              </div>
              <Button
                type="button"
                className="h-10 w-full rounded-[10px] bg-primary px-4 text-on-primary hover:opacity-90 sm:w-auto"
                onClick={startTokenCreation}
                iconLeft={<Plus className="h-4 w-4" />}
              >
                {t("DashboardIssuance.workspace.createDraft")}
              </Button>
            </div>

            {/* Asset count, and — in list view — the expand/collapse-all control.
                Fixed height and always mounted, so the header's height never
                changes as rows open and close. */}
            <div className="flex h-6 items-center justify-between px-1">
              {/* Range over the filtered total, not the loaded rows — with paging,
                  "24 assets" would be a lie about a project holding 400.
                  While a new result set is loading the count belongs to the old
                  one, so it gives way to a placeholder rather than asserting a
                  number that is about to change. */}
              {isLoadingNewResults ? (
                <SkeletonBlock className="h-3 w-28" />
              ) : (
                <p className="text-xs text-tertiary">
                  {total > 0 && pageCount > 1
                    ? t("DashboardIssuance.pagination.rangeAssets", {
                        start: rangeStart,
                        end: rangeEnd,
                        total,
                      })
                    : t("DashboardIssuance.list.assetsCount", { count: total })}
                </p>
              )}
              {/* Mirrors the grid ⇄ list cross-fade below: same key, same
                  `mode="wait"`, same transition. Both presences are driven by the
                  one `view` change in the same render, so the control fades out
                  with the outgoing view and in with the incoming one instead of
                  popping the moment the toggle is clicked. Grid renders an empty
                  placeholder rather than nothing so there is always a child to
                  wait on — that wait is what puts the fade-in on the list's beat
                  rather than a third of a second ahead of it. */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={view}
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                  transition={viewTransition}
                  className="flex items-center"
                >
                  {view === "list" ? (
                    <button
                      type="button"
                      data-testid="token-collapse-all"
                      onClick={hasOpenTokenRows ? collapseAllTokenRows : expandAllTokenRows}
                      className="-mr-1.5 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-secondary outline-none transition-colors hover:bg-fill hover:text-primary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]"
                    >
                      {hasOpenTokenRows ? (
                        <ChevronsDownUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      )}
                      {t(
                        hasOpenTokenRows
                          ? "DashboardIssuance.workspace.collapseAll"
                          : "DashboardIssuance.workspace.expandAll"
                      )}
                    </button>
                  ) : null}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {listErrorMessage ? (
            <p className="mb-4 text-sm text-error" role="alert">
              {listErrorMessage}
            </p>
          ) : null}
          {emptyResultsNotice}

          <IssuanceResults
            view={view}
            reduceMotion={Boolean(reduceMotion)}
            isLoadingNewResults={isLoadingNewResults}
            isLoadingAnotherPage={isLoadingAnotherPage}
            skeletonCount={skeletonCount}
            tokens={tokens}
            signerWallets={signerWallets}
            openTokenIds={openTokenIds}
            onToggleRow={toggleTokenRow}
            onCreate={startTokenCreation}
            pagination={pagination}
            t={t}
            locale={locale}
          />
        </>
      }
      playground={playgroundContent}
    />
  );
}
