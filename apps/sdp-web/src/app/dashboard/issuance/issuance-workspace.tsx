"use client";

import { Popover } from "@base-ui/react/popover";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { Info, PlusIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  WalletMetadataCopyButton,
  WalletMetaValue,
} from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatWalletMeta } from "@/app/dashboard/custody/wallet-format-utils";
import {
  dashboardWorkspaceOverviewPanelClassName,
  dashboardWorkspacePlaygroundPanelClassName,
} from "@/components/dashboard-workspace-panel";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { cn } from "@/lib/utils";
import { CreateIssuanceTokenModal } from "./create-token-modal";
import { IssuanceFilterPopover } from "./issuance-filter-popover";
import { IssuanceLegacyOverview } from "./issuance-legacy-overview";
import type { IssuanceFilterState, IssuanceListQuery } from "./issuance-list-query";
import { IssuanceListSkeleton } from "./issuance-list-skeleton";
import { IssuancePlaygroundLoading } from "./issuance-playground-loading";
import {
  buildSmartDate,
  deploymentStatusBadge,
  getDeploymentStatus,
  getTokenTypeLabel,
  type IssuanceTokenView,
  tokenMarkInitial,
} from "./issuance-token-fields";
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
// The header's `pb-*` is the ceiling on how long the fade can be — the band cannot
// hang below the header's box, because at rest the box's bottom edge is exactly the
// first card's top edge, and the header paints above the cards (z-20). Any overhang
// would wash out that card's top border while it is sitting still. Smoothstep is
// what buys the softness back at this length.
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

// The (i) beside the grid tile's date label. Needs `relative z-10` because the
// card's full-bleed link is an `absolute inset-0` sibling that otherwise paints
// over the label and swallows its pointer events — which is why a plain `title`
// attribute here would never fire. Clicking the icon therefore does not follow
// the card's link; the rest of the card still does.
function StatHint({ hint }: { hint: { label: string; value: string } }) {
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
        {/* Above the workspace's pinned header (z-20) — it opens upward from a
            scrolling card. */}
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

function IssuanceTokenGridCard({
  token,
  t,
  locale,
}: {
  token: IssuanceTokenView;
  t: ReturnType<typeof useTranslations>;
  locale: ReturnType<typeof useLocale>;
}) {
  const statusBadge = deploymentStatusBadge(getDeploymentStatus(token), t);
  const smartDate = buildSmartDate(token, t, locale);

  return (
    <article
      data-testid={`token-card-${token.id}`}
      className="relative flex flex-col rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)] transition hover:border-primary/30 hover:shadow-[0_4px_16px_rgba(28,28,29,0.08)]"
    >
      <Link
        href={`/dashboard/issuance/${token.id}`}
        aria-label={t("DashboardIssuance.workspace.manageAsset", {
          name: token.name,
        })}
        className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
      />
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-2xl border border-border-subtle bg-fill-subtle">
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
              <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-tertiary">
                {tokenMarkInitial(token.symbol)}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium tracking-wide text-tertiary">{token.symbol}</p>
            <h3 className="mt-0.5 truncate text-2xl leading-tight font-medium tracking-tight text-primary">
              {token.name}
            </h3>
          </div>
        </div>
        <span
          data-testid={`token-card-status-${token.id}`}
          className={cn(
            "inline-flex shrink-0 items-center self-start rounded-full px-2.5 py-1 text-xs font-medium capitalize",
            statusBadge.badge
          )}
        >
          {statusBadge.label}
        </span>
      </div>

      <div className="mt-5 space-y-1.5">
        <div className="flex h-6 items-center justify-between gap-3 text-xs">
          <span className="text-tertiary">{t("DashboardIssuance.list.mintAddress")}</span>
          {token.mintAddress !== null ? (
            <div className="relative z-10 flex min-w-0 items-center gap-1">
              <WalletMetaValue
                value={token.mintAddress}
                displayValue={formatWalletMeta(token.mintAddress)}
              />
              <WalletMetadataCopyButton
                value={token.mintAddress}
                label={t("DashboardIssuance.list.mintAddress")}
                tooltip={token.mintAddress}
              />
            </div>
          ) : (
            <span className="text-tertiary italic">
              {t("DashboardIssuance.header.notDeployed")}
            </span>
          )}
        </div>
        <div className="flex h-6 items-center justify-between gap-3 text-xs">
          <span className="text-tertiary">{t("DashboardIssuance.header.tokenId")}</span>
          <div className="relative z-10 flex min-w-0 items-center gap-1">
            <WalletMetaValue value={token.id} displayValue={formatWalletMeta(token.id, 10, 6)} />
            <WalletMetadataCopyButton
              value={token.id}
              label={t("DashboardIssuance.header.tokenId")}
              tooltip={token.id}
            />
          </div>
        </div>
        <div className="flex h-6 items-center justify-between gap-3 text-xs">
          <span className="flex min-w-0 items-center gap-1 text-tertiary">
            <span className="truncate">{smartDate.label}</span>
            {smartDate.hint ? <StatHint hint={smartDate.hint} /> : null}
          </span>
          <span className="shrink-0 text-secondary">{smartDate.value}</span>
        </div>
      </div>
    </article>
  );
}

// The results area: placeholders or the grid.
//
// Extracted from the workspace so the loading branch doesn't push that function
// over the complexity budget.
function IssuanceResults({
  isLoadingNewResults,
  isLoadingAnotherPage,
  skeletonCount,
  tokens,
  onCreate,
  pagination,
  t,
  locale,
}: {
  isLoadingNewResults: boolean;
  isLoadingAnotherPage: boolean;
  skeletonCount: number;
  tokens: IssuanceTokenView[];
  onCreate: () => void;
  pagination: ReactNode;
  t: ReturnType<typeof useTranslations>;
  locale: ReturnType<typeof useLocale>;
}) {
  const grid = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tokens.map((token) => (
        <IssuanceTokenGridCard key={token.id} token={token} t={t} locale={locale} />
      ))}

      <button
        type="button"
        onClick={onCreate}
        data-testid="token-add-card"
        className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised text-tertiary transition-colors hover:border-primary/40 hover:text-secondary"
      >
        <PlusIcon className="h-6 w-6" />
        <span className="text-sm font-medium">{t("DashboardIssuance.workspace.addNewToken")}</span>
      </button>
    </div>
  );

  return (
    <>
      {/* One announcement for every kind of load, so a screen reader hears that the
          grid is working whether the tiles were replaced or only dimmed. */}
      <span className="sr-only" role="status" aria-live="polite">
        {isLoadingNewResults || isLoadingAnotherPage
          ? t("DashboardIssuance.workspace.loadingAssets")
          : ""}
      </span>

      <div
        // Paging keeps the tiles on screen (keepPreviousData) because they are a
        // neighbouring slice of the same list; the dim is what marks them as the
        // previous ones. A new result set gets placeholders instead — those tiles
        // answer a question that is no longer being asked.
        aria-busy={isLoadingNewResults || isLoadingAnotherPage}
        className={isLoadingAnotherPage ? "opacity-60 transition-opacity" : "transition-opacity"}
      >
        {isLoadingNewResults ? <IssuanceListSkeleton count={skeletonCount} /> : grid}
      </div>

      {isLoadingNewResults ? null : pagination}
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
  const { issuanceTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();
  const router = useRouter();
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
        panels={[
          {
            id: "overview",
            className: cn(dashboardWorkspaceOverviewPanelClassName, "space-y-6"),
            content: (
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
            ),
          },
          {
            id: "playground",
            className: dashboardWorkspacePlaygroundPanelClassName,
            content: playgroundContent,
          },
        ]}
      />
    );
  }

  return (
    <DashboardWorkspaceTabShell
      panels={[
        {
          id: "overview",
          className: cn(dashboardWorkspaceOverviewPanelClassName, ISSUANCE_OVERVIEW_PANEL_CLASS),
          content: (
            <>
              {/* Pinned header. Negative margins bleed the backdrop across the panel's
              horizontal padding so nothing shows through at the edges as content
              scrolls behind it.

              Issuance z ladder: header z-20 < this feature's popovers z-30 < the DS
              popup layer z-50 (Select, DropdownMenu, Combobox, Modal — all portalled
              to body). Keeping the whole ladder under 50 is what lets a Select opened
              inside the filter popover paint above that popover's panel. */}
              <div
                // Even `py-6` around the toolbar. The 12px fade band sits entirely
                // inside the bottom padding (it must never hang below the header's
                // box — at rest that edge is the first card's top), so the toolbar
                // always reads as being on solid backdrop.
                className="sticky top-0 z-20 -mx-3 space-y-4 px-3 py-6 md:-mx-6 md:px-6"
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
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="w-full sm:max-w-md">
                    <SearchInput
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t("DashboardIssuance.workspace.search")}
                      // Keystrokes are debounced and answered by the server, so the
                      // input says so — otherwise typing has no acknowledgement at
                      // all until the rows change.
                      pending={isSearchPending}
                      clear={{
                        label: t("DashboardIssuance.workspace.clearSearch"),
                        onClear: () => setSearch(""),
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Filter & sort — icon-only trigger opening a popover. */}
                    <IssuanceFilterPopover
                      filters={query}
                      onChange={updateFilters}
                      onClear={clearFilters}
                      templateOptions={templateOptions}
                    />
                    <Button
                      type="button"
                      className="h-10 w-full rounded-[10px] bg-primary px-4 text-on-primary hover:opacity-90 sm:w-auto"
                      onClick={startTokenCreation}
                      iconLeft={<PlusIcon className="h-4 w-4" />}
                    >
                      {t("DashboardIssuance.workspace.createDraft")}
                    </Button>
                  </div>
                </div>
              </div>

              {listErrorMessage ? (
                <p className="mb-4 text-sm text-error" role="alert">
                  {listErrorMessage}
                </p>
              ) : null}
              {emptyResultsNotice}

              <IssuanceResults
                isLoadingNewResults={isLoadingNewResults}
                isLoadingAnotherPage={isLoadingAnotherPage}
                skeletonCount={skeletonCount}
                tokens={tokens}
                onCreate={startTokenCreation}
                pagination={pagination}
                t={t}
                locale={locale}
              />
            </>
          ),
        },
        {
          id: "playground",
          className: dashboardWorkspacePlaygroundPanelClassName,
          content: playgroundContent,
        },
      ]}
    />
  );
}
