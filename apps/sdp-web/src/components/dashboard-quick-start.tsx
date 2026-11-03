"use client";

import { Button } from "@sdp/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { cn } from "@sdp/ui/cn";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ListChecks, MinusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  DASHBOARD_INTEGRATIONS_SUBNAV_HREFS,
  DASHBOARD_SIDE_NAV_HREFS,
} from "@/lib/dashboard-navigation-loading";
import {
  countSettledQuickStartSteps,
  dismissQuickStart,
  QUICK_START_STEP_IDS,
  type QuickStartStatus,
  type QuickStartStep,
  type QuickStartStepState,
  resumeQuickStart,
  setQuickStartCollapsed,
  skipQuickStartStep,
} from "@/lib/dashboard-quick-start";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useQuickStart } from "./use-quick-start";

type Translate = ReturnType<typeof useTranslations>;

const TOTAL_STEPS = QUICK_START_STEP_IDS.length;
const CREATE_API_KEY_HREF = "/dashboard/api-keys/new";

/** Re-renders on an interval so "40s ago" keeps counting while the guide is open. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const RELATIVE_UNITS = [
  { unit: "second", seconds: 1 },
  { unit: "minute", seconds: 60 },
  { unit: "hour", seconds: 3_600 },
  { unit: "day", seconds: 86_400 },
] as const;

function formatSince(iso: string, locale: string, now: number, style: "long" | "narrow"): string {
  const elapsed = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const { unit, seconds } =
    [...RELATIVE_UNITS].reverse().find((candidate) => elapsed >= candidate.seconds) ??
    RELATIVE_UNITS[0];
  return new Intl.RelativeTimeFormat(locale, { style }).format(
    -Math.floor(elapsed / seconds),
    unit
  );
}

/** "today", "yesterday", "3 days ago": a skip is remembered by the day, not the second. */
function formatSinceDay(iso: string, locale: string, now: number): string {
  const startOfDay = (time: number) => {
    const date = new Date(time);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(Date.parse(iso))) / 86_400_000);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-Math.max(0, days), "day");
}

interface StepAction {
  label: string;
  href?: string;
  onSelect?: () => void;
}

interface StepCopy {
  title: string;
  description: string;
  meta: string;
  href: string;
  actions: StepAction[];
}

function stepCopy(
  step: QuickStartStep,
  context: {
    t: Translate;
    locale: string;
    now: number;
    status: QuickStartStatus;
    storageKey: string;
    skippedAt: string | undefined;
  }
): StepCopy {
  const { t, locale, now, status, storageKey, skippedAt } = context;
  if (step.id === "custody") {
    const connect = {
      label: t("Shared.quickStart.custodyConnect"),
      href: DASHBOARD_INTEGRATIONS_SUBNAV_HREFS.custody,
    };
    const title = t("Shared.quickStart.custodyTitle");
    if (step.state === "done") {
      return {
        title,
        href: connect.href,
        description: t("Shared.quickStart.custodyDoneDescription"),
        meta: t("Shared.quickStart.custodyDoneMeta"),
        actions: [{ ...connect, label: t("Shared.quickStart.custodyManage") }],
      };
    }
    if (step.state === "skipped" && skippedAt) {
      const when = formatSinceDay(skippedAt, locale, now);
      return {
        title,
        href: connect.href,
        description: t("Shared.quickStart.custodySkippedDescription", { when }),
        meta: t("Shared.quickStart.custodySkippedMeta", { when }),
        actions: [connect],
      };
    }
    return {
      title,
      href: connect.href,
      description: t("Shared.quickStart.custodyPendingDescription"),
      meta: t("Shared.quickStart.custodyPendingMeta"),
      actions: [
        {
          label: t("Shared.quickStart.custodySkip"),
          onSelect: () => skipQuickStartStep(storageKey, "custody"),
        },
        connect,
      ],
    };
  }

  const title = t("Shared.quickStart.firstCallTitle");
  if (step.state === "done" && status.lastCallAt) {
    return {
      title,
      href: DASHBOARD_SIDE_NAV_HREFS.apiKeys,
      description: t("Shared.quickStart.firstCallDoneDescription", {
        when: formatSince(status.lastCallAt, locale, now, "long"),
      }),
      meta: t("Shared.quickStart.firstCallDoneMeta", {
        when: formatSince(status.lastCallAt, locale, now, "narrow"),
      }),
      actions: [],
    };
  }
  if (status.apiKeyCount > 0) {
    return {
      title,
      href: DASHBOARD_SIDE_NAV_HREFS.apiKeys,
      description: t("Shared.quickStart.firstCallWaitingDescription"),
      meta: t("Shared.quickStart.firstCallWaitingMeta"),
      actions: [
        { label: t("Shared.quickStart.viewApiKeys"), href: DASHBOARD_SIDE_NAV_HREFS.apiKeys },
      ],
    };
  }
  return {
    title,
    href: CREATE_API_KEY_HREF,
    description: t("Shared.quickStart.firstCallNeedsKeyDescription"),
    meta: t("Shared.quickStart.firstCallNeedsKeyMeta"),
    actions: [{ label: t("Shared.quickStart.createApiKey"), href: CREATE_API_KEY_HREF }],
  };
}

function useStepCopies(quickStart: ReturnType<typeof useQuickStart>): StepCopy[] {
  const t = useTranslations();
  const locale = useLocale();
  const now = useNow(15_000);
  const projectHref = useProjectHref();
  const { status, storageKey, prefs, steps } = quickStart;
  if (!status) return [];
  return steps
    .map((step) =>
      stepCopy(step, {
        t,
        locale,
        now,
        status,
        storageKey,
        skippedAt: prefs.skipped.custody,
      })
    )
    .map((copy) => ({
      ...copy,
      href: projectHref(copy.href),
      actions: copy.actions.map((action) =>
        action.href ? { ...action, href: projectHref(action.href) } : action
      ),
    }));
}

/**
 * A step's state as a 20px mark: a filled tick when done, a filled dash when skipped, and a
 * dashed ring while waiting on the person.
 */
function StepMark({ state, size = "md" }: { state: QuickStartStepState; size?: "sm" | "md" }) {
  const box = size === "md" ? "size-5" : "size-4";
  const glyph = size === "md" ? "size-3" : "size-2.5";
  if (state === "done" || state === "skipped") {
    const Icon = state === "done" ? CheckIcon : MinusIcon;
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full text-on-primary",
          box,
          state === "done" ? "bg-success" : "bg-tertiary"
        )}
      >
        <Icon className={glyph} strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn("shrink-0 rounded-full border-[0.0938rem] border-dashed border-tertiary", box)}
    />
  );
}

function stateLabel(t: Translate, state: QuickStartStepState): string {
  return t(`Shared.quickStart.state.${state}`);
}

/** How full each step's bar reads, by what the step has reached. */
const PROGRESS_BAR_FILL = {
  done: "bg-success",
  skipped: "bg-tertiary",
  pending: "bg-primary/15",
} as const satisfies Record<QuickStartStepState, string>;

/** Two 22px bars, one per step, filled by what each step has reached. */
function ProgressBars({ steps }: { steps: readonly QuickStartStep[] }) {
  return (
    <span aria-hidden="true" className="flex items-center gap-1">
      {steps.map((step) => (
        <span
          key={step.id}
          className={cn("h-0.75 w-5.5 rounded-full", PROGRESS_BAR_FILL[step.state])}
        />
      ))}
    </span>
  );
}

function StepActionControl({ action }: { action: StepAction }) {
  const className =
    "inline-flex h-control-sm items-center text-body font-medium text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2";
  if (action.href) {
    return (
      <Link href={action.href} className={className}>
        {action.label}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={action.onSelect}
      className={cn(className, "text-secondary hover:text-primary")}
    >
      {action.label}
    </button>
  );
}

/**
 * The Overview's quick start: a framed list of the two setup signals, each with where it
 * stands and the one thing to do next. A solid rule joins a done step to the next, a dashed one
 * everything still open.
 */
function OverviewQuickStart({ quickStart }: { quickStart: ReturnType<typeof useQuickStart> }) {
  const t = useTranslations();
  const copies = useStepCopies(quickStart);
  const { steps, prefs, storageKey } = quickStart;
  const settled = countSettledQuickStartSteps(steps);
  const collapsed = prefs.collapsed;
  const listId = "overview-quick-start-steps";
  return (
    <section
      aria-labelledby="overview-quick-start-title"
      data-overview-section="quick-start"
      className="min-w-0 rounded-card border border-border-default bg-surface-sunken"
    >
      <div className="flex min-h-16 items-center gap-3 py-2 pr-3 pl-5">
        <h2 id="overview-quick-start-title" className="text-nav font-medium text-primary">
          {t("Shared.quickStart.newDesign.title")}
        </h2>
        <span className="hidden sm:flex">
          <ProgressBars steps={steps} />
        </span>
        <span className="text-body text-tertiary tabular-nums">
          {t("Shared.quickStart.progressCount", { settled, total: TOTAL_STEPS })}
        </span>
        <span className="ml-auto flex items-center gap-4">
          <button
            type="button"
            onClick={() => dismissQuickStart(storageKey)}
            // Names the guide: a page's own "Dismiss" (a new key's secret) sits beside it.
            aria-label={t("Shared.quickStart.dismissConfirm")}
            className="inline-flex h-control-sm items-center rounded-control px-2 text-body text-secondary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {t("Shared.quickStart.dismiss")}
          </button>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={listId}
            onClick={() => setQuickStartCollapsed(storageKey, "overview", !collapsed)}
            className="inline-flex h-control-sm items-center gap-2 rounded-control px-2 text-body text-secondary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {t(collapsed ? "Shared.quickStart.show" : "Shared.quickStart.hide")}
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-4 transition-transform", collapsed ? "" : "rotate-180")}
            />
          </button>
        </span>
      </div>
      {collapsed ? null : (
        <ol id={listId} className="space-y-8 border-t border-border-subtle px-5 py-4">
          {steps.map((step, index) => {
            const copy = copies[index];
            if (!copy) return null;
            const next = steps[index + 1];
            return (
              <li
                key={step.id}
                data-step={step.id}
                data-state={step.state}
                className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-x-4 sm:grid-cols-[20px_minmax(0,1fr)_auto]"
              >
                <StepMark state={step.state} />
                <div className="min-w-0">
                  <p
                    className={cn(
                      "text-nav",
                      step.state === "skipped" ? "text-secondary" : "text-primary"
                    )}
                  >
                    {copy.title}
                    <span className="sr-only">, {stateLabel(t, step.state)}</span>
                  </p>
                  <p className="text-body text-secondary">{copy.description}</p>
                </div>
                <div className="col-start-2 mt-2 flex flex-col items-start sm:col-start-3 sm:row-start-1 sm:mt-0 sm:items-end">
                  <p className="text-meta leading-5 text-tertiary">{copy.meta}</p>
                  {copy.actions.length > 0 ? (
                    <div className="mt-2 flex items-center gap-4">
                      {copy.actions.map((action) => (
                        <StepActionControl key={action.label} action={action} />
                      ))}
                    </div>
                  ) : null}
                </div>
                {next ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-6 -bottom-7 left-[0.5938rem] w-px",
                      step.state === "done"
                        ? "bg-success/45"
                        : "bg-[repeating-linear-gradient(to_bottom,var(--emph-l)_0_3px,transparent_3px_6px)] opacity-70"
                    )}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * The same two steps at the foot of the sidebar, so setup stays in reach from every page.
 * Each row goes where its step is done; the header folds the card to one line.
 */
function SidebarQuickStart({
  quickStart,
  collapsedRail,
}: {
  quickStart: ReturnType<typeof useQuickStart>;
  collapsedRail: boolean;
}) {
  const t = useTranslations();
  const copies = useStepCopies(quickStart);
  const { steps, prefs, storageKey } = quickStart;
  const settled = countSettledQuickStartSteps(steps);
  const progress = t("Shared.quickStart.progressCount", { settled, total: TOTAL_STEPS });
  const label = `${t("Shared.quickStart.sidebarTitle")} · ${progress}`;
  const projectHref = useProjectHref();

  if (collapsedRail) {
    return (
      <Link
        href={projectHref(DASHBOARD_SIDE_NAV_HREFS.home)}
        aria-label={label}
        title={label}
        data-quick-start-sidebar
        className="flex h-10 w-full items-center justify-center rounded-control text-secondary hover:bg-fill-subtle hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <ListChecks className="size-4" aria-hidden="true" />
      </Link>
    );
  }

  const collapsed = prefs.sidebarCollapsed;
  const listId = "sidebar-quick-start-steps";
  return (
    <aside
      aria-label={t("Shared.quickStart.sidebarTitle")}
      data-quick-start-sidebar
      className="shrink-0 rounded-card border border-border-default text-primary"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => setQuickStartCollapsed(storageKey, "sidebar", !collapsed)}
        className="flex h-9 w-full items-center gap-2 rounded-card px-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span className="text-meta font-medium">{t("Shared.quickStart.sidebarTitle")}</span>
        <span className="ml-auto text-meta text-tertiary tabular-nums">{progress}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-4 text-tertiary transition-transform", collapsed ? "-rotate-90" : "")}
        />
      </button>
      {collapsed ? null : (
        <>
          <ul id={listId} className="border-t border-border-subtle">
            {steps.map((step, index) => {
              const copy = copies[index];
              if (!copy) return null;
              return (
                <li key={step.id}>
                  <Link
                    href={copy.href}
                    className="flex h-9 min-w-0 items-center gap-2 px-3 text-meta text-primary transition-colors hover:bg-fill-subtle focus-visible:outline-2 focus-visible:-outline-offset-2"
                  >
                    <StepMark state={step.state} size="sm" />
                    <span className="min-w-0 flex-1 truncate">
                      {copy.title}
                      <span className="sr-only">, {stateLabel(t, step.state)}</span>
                    </span>
                    <ChevronRightIcon
                      className="size-4 shrink-0 text-tertiary"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="flex h-8 items-center justify-between border-t border-border-subtle px-1">
            <button
              type="button"
              onClick={() => dismissQuickStart(storageKey)}
              aria-label={t("Shared.quickStart.dismissConfirm")}
              className="inline-flex h-7 items-center rounded-control px-2 text-meta text-secondary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {t("Shared.quickStart.dismiss")}
            </button>
            <button
              type="button"
              aria-expanded
              aria-controls={listId}
              onClick={() => setQuickStartCollapsed(storageKey, "sidebar", true)}
              className="inline-flex h-7 items-center rounded-control px-2 text-meta text-secondary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {t("Shared.quickStart.hide")}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

/** Settings → Onboarding: where the guide stands, and the way back to it once dismissed. */
function SettingsQuickStart({ quickStart }: { quickStart: ReturnType<typeof useQuickStart> }) {
  const t = useTranslations();
  const router = useRouter();
  const projectHref = useProjectHref();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { eligible, complete, prefs, status, steps, storageKey } = quickStart;
  const settled = countSettledQuickStartSteps(steps);
  let description: string;
  if (sdpEnvironment !== "sandbox") {
    description = t("Shared.quickStart.newDesign.settingsSandbox");
  } else if (!eligible || (status === null && !prefs.dismissed)) {
    // Unknown is not new: until the status reads, there is no guide to open. A dismissed guide is
    // not reading it at all, so bringing it back is what starts the read.
    description = t("Shared.quickStart.settingsUnavailable");
  } else if (complete) {
    description = t("Shared.quickStart.settingsComplete");
  } else {
    description = t("Shared.quickStart.settingsProgress", { settled, total: TOTAL_STEPS });
  }
  const canOpen = eligible && (status !== null || prefs.dismissed) && !complete;
  return (
    <Card id="onboarding" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h2>{t("Shared.quickStart.settingsTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("Shared.quickStart.newDesign.settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{t("Shared.quickStart.newDesign.title")}</h3>
          <p className="text-sm text-secondary">{description}</p>
        </div>
        {canOpen ? (
          <Button
            variant="secondary"
            onClick={() => {
              if (prefs.dismissed) resumeQuickStart(storageKey);
              router.push(projectHref(DASHBOARD_SIDE_NAV_HREFS.home));
            }}
          >
            {t(
              prefs.dismissed ? "Shared.quickStart.settingsShow" : "Shared.quickStart.settingsOpen"
            )}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The quick start in the sidebar, on the Overview and in Settings, built on live signals.
 */
export function DashboardQuickStart({
  collapsed = false,
  variant = "sidebar",
}: {
  /** The sidebar is folded to its icon rail. */
  collapsed?: boolean;
  variant?: "sidebar" | "overview" | "settings";
}) {
  const quickStart = useQuickStart();
  if (variant === "settings") return <SettingsQuickStart quickStart={quickStart} />;
  if (!quickStart.visible) return null;
  if (variant === "overview") return <OverviewQuickStart quickStart={quickStart} />;
  return <SidebarQuickStart quickStart={quickStart} collapsedRail={collapsed} />;
}
