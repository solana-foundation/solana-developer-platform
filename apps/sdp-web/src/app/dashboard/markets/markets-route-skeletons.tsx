import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

const BALANCE_SKELETON_IDS = ["one", "two", "three"];
const STRATEGY_SKELETON_IDS = ["one", "two", "three", "four", "five"];
const TREASURY_SECTION_SKELETON_IDS = ["one", "two"];
const LANDING_PATH_SKELETON_IDS = ["treasury", "program", "dvp"];
const INTEGRATION_SECTION_SKELETON_IDS = ["client", "deposit", "portfolio", "withdraw"];

export function MarketsLandingSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="max-w-3xl">
          <SkeletonBlock className="h-3 w-28" />
          <SkeletonBlock className="mt-3 h-4 w-[32rem] max-w-full" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {LANDING_PATH_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-40 w-full rounded-2xl" key={id} />
          ))}
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function TreasurySolutionsSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-16">
        <div className="grid gap-2 sm:grid-cols-3">
          {BALANCE_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-[121px] rounded-xl" key={`summary-${id}`} />
          ))}
        </div>
        <section>
          <div className="flex items-center justify-between gap-4">
            <SkeletonBlock className="h-6 w-36" />
            <SkeletonBlock className="h-7 w-16 rounded-md" />
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-3">
            {BALANCE_SKELETON_IDS.map((id) => (
              <SkeletonBlock className="h-[175px] rounded-2xl" key={`wallet-${id}`} />
            ))}
          </div>
        </section>
        {TREASURY_SECTION_SKELETON_IDS.map((section) => (
          <section key={section}>
            <SkeletonBlock className="h-6 w-40" />
            <div className="mt-4 overflow-hidden rounded-2xl border border-border-default">
              {STRATEGY_SKELETON_IDS.slice(0, 3).map((id) => (
                <SkeletonBlock className="h-[60px] w-full rounded-none" key={`${section}-${id}`} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function EmbeddedYieldPortfolioSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div
        className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 pt-3"
        data-embedded-yield-loading="portfolio"
      >
        <div className="flex items-center justify-between gap-4">
          <SkeletonBlock className="h-6 w-48" />
          <SkeletonBlock className="h-6 w-20 rounded-md" />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {BALANCE_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-44 rounded-2xl" key={`portfolio-${id}`} />
          ))}
        </div>
        <SkeletonBlock className="h-[302px] w-full rounded-2xl" />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function EarnIntegrationGuideSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto w-full max-w-5xl space-y-5" data-embedded-yield-loading="integrate">
        <SkeletonBlock className="h-8 w-28 rounded-md" />
        <div className="max-w-3xl">
          <SkeletonBlock className="h-3 w-32" />
          <SkeletonBlock className="mt-3 h-7 w-72 max-w-full" />
          <SkeletonBlock className="mt-3 h-4 w-[38rem] max-w-full" />
        </div>
        <section className="rounded-xl border border-border-default bg-surface-raised p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-5 w-36" />
              <SkeletonBlock className="mt-2 h-4 w-80 max-w-full" />
            </div>
            <SkeletonBlock className="h-8 w-40 rounded-md" />
          </div>
          <SkeletonBlock className="mt-6 h-12 w-full rounded-xl" />
          <SkeletonBlock className="mt-4 h-28 w-full rounded-xl" />
        </section>
        <div className="grid grid-cols-4 gap-2">
          {INTEGRATION_SECTION_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-9 w-full rounded-lg" key={id} />
          ))}
        </div>
        <section>
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="mt-2 h-4 w-[34rem] max-w-full" />
          <SkeletonBlock className="mt-6 h-56 w-full rounded-xl" />
        </section>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

const DVP_ROW_SKELETON_IDS = ["one", "two", "three", "four", "five"];
const DVP_LEG_SKELETON_IDS = ["a", "b"];

export function DvpTradesSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true" className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto flex w-full max-w-[63rem] flex-col gap-6">
        {/* Description and the create button share a row. */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <SkeletonBlock className="h-4 w-[28rem] max-w-full" />
          <SkeletonBlock className="h-8 w-28 shrink-0 rounded-lg" />
        </div>
        {/* The toolbar, in its real shape: a pill segmented control on the
            left and the search field on the right, at the heights and radii
            those components actually render at. A skeleton that draws two
            same-sized boxes hands over to something a different shape, which is
            the jump it exists to prevent. */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <SkeletonBlock className="h-9 w-full max-w-[22rem] rounded-full" />
          <SkeletonBlock className="h-10 w-full rounded-[10px] md:w-64 md:shrink-0" />
        </div>
        <div className="overflow-hidden rounded-2xl border border-border-default">
          <SkeletonBlock className="h-11 w-full rounded-none" />
          {DVP_ROW_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-[68px] w-full rounded-none" key={`trade-${id}`} />
          ))}
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function DvpTradeDetailSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true" className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto flex w-full max-w-[63rem] flex-col gap-6">
        {/* The header carries the badge, both SDP-created addresses with their
            explanations, the funding wallet and up to three transactions — far
            more than the 86px this claimed while the page below it grew. */}
        <SkeletonBlock className="h-[320px] w-full rounded-2xl" />
        {/* Whose move it is. */}
        <SkeletonBlock className="h-[92px] w-full rounded-2xl" />
        {/* The direction band between the legs. */}
        <SkeletonBlock className="h-[52px] w-full rounded-xl" />
        <div className="grid gap-4 md:grid-cols-2">
          {DVP_LEG_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-[264px] w-full rounded-2xl" key={`leg-${id}`} />
          ))}
        </div>
        <SkeletonBlock className="h-[152px] w-full rounded-2xl" />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

/** The three grouped sections the form is actually built from. */
/** Five dots, matching the wizard's stages. */
const DVP_WIZARD_STEPS = ["role", "parties", "legs", "terms", "review"];

export function DvpCreateSkeleton() {
  return (
    <div aria-busy="true" className="flex h-full min-h-0 w-full flex-col">
      {/* Mirrors WizardFrame, not the old single-page form: a stepper strip, ONE
          stage of content beside a 440px rail, and a footer bar. The previous
          version described three stacked section cards at max-w-5xl, which is a
          different width AND a different shape from what loads - the exact
          handover jump its own comment was written to stop. */}
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-4">
          <div className="flex items-center gap-1.5">
            {DVP_WIZARD_STEPS.map((step) => (
              <SkeletonBlock className="h-1.5 w-6 rounded-full" key={step} />
            ))}
          </div>
          <SkeletonBlock className="h-4 w-20" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto w-full max-w-6xl pb-8">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_440px]">
            <div className="min-w-0">
              <SkeletonBlock className="h-8 w-64" />
              <SkeletonBlock className="mt-2 h-4 w-full max-w-xl" />
              {/* One stage, not the whole form. */}
              <div className="mt-6 grid gap-5">
                <SkeletonBlock className="h-[92px] w-full rounded-xl" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <SkeletonBlock className="h-[124px] w-full rounded-2xl" />
                  <SkeletonBlock className="h-[124px] w-full rounded-2xl" />
                </div>
              </div>
            </div>
            <SkeletonBlock className="hidden h-[260px] w-full rounded-2xl lg:block" />
          </div>
        </div>
      </div>

      <div className="shrink-0 border-border-default border-t px-4 pt-4 pb-4 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
          <SkeletonBlock className="h-10 w-24 rounded-lg" />
          <SkeletonBlock className="h-10 w-28 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
