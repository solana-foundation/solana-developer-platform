import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import { z } from "zod";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "./dashboard-cache-scope";
import {
  completeQuickStartStep as completeLegacyQuickStartStep,
  quickStartKey as legacyQuickStartKey,
} from "./dashboard-quick-start";
import { type DesignFlags, isDesignModuleOn } from "./design-modules";

/**
 * What the server knows about an organization's setup: the custody provider it connected, and
 * whether any of its keys has signed a request yet. Read once per
 * page load by the dashboard layout and refreshed while the guide is on screen.
 */
export const quickStartStatusSchema = z.object({
  custodyProvider: z.enum(CUSTODY_PROVIDERS).nullable(),
  apiKeyCount: z.number().int().nonnegative(),
  /** When a key last signed a request; null until the first one arrives. */
  lastCallAt: z.string().nullable(),
});
export type QuickStartStatus = z.infer<typeof quickStartStatusSchema>;

export const QUICK_START_STEP_IDS = ["custody", "first-call"] as const;
export type QuickStartStepId = (typeof QUICK_START_STEP_IDS)[number];

/**
 * - done: the signal is in (a provider is connected, a call arrived).
 * - skipped: the person chose to leave it; only custody can be skipped.
 * - pending: waiting on the person.
 */
export type QuickStartStepState = "done" | "skipped" | "pending";

export interface QuickStartStep {
  id: QuickStartStepId;
  state: QuickStartStepState;
}

export interface QuickStartPrefs {
  dismissed: boolean;
  /** The Overview card is folded to its header. */
  collapsed: boolean;
  /** The sidebar card is folded to its header. */
  sidebarCollapsed: boolean;
  /** When each skippable step was skipped. */
  skipped: Partial<Record<"custody", string>>;
}

export const EMPTY_QUICK_START_PREFS: QuickStartPrefs = Object.freeze({
  dismissed: false,
  collapsed: false,
  sidebarCollapsed: false,
  skipped: Object.freeze({}),
});

/** A connected provider wins over an earlier skip. */
function resolveCustodyState(
  status: QuickStartStatus,
  skipped: QuickStartPrefs["skipped"]
): QuickStartStepState {
  if (status.custodyProvider) return "done";
  if (skipped.custody) return "skipped";
  return "pending";
}

/**
 * Resolves each step from what the server reports plus what the person chose.
 *
 * @param input.status - The server's setup status.
 * @param input.skipped - Steps the person skipped.
 * @returns The two steps in order.
 */
export function resolveQuickStartSteps({
  status,
  skipped,
}: {
  status: QuickStartStatus;
  skipped: QuickStartPrefs["skipped"];
}): QuickStartStep[] {
  const firstCall: QuickStartStepState = status.lastCallAt ? "done" : "pending";
  return [
    { id: "custody", state: resolveCustodyState(status, skipped) },
    { id: "first-call", state: firstCall },
  ];
}

/** Steps the person no longer has to act on: done, or skipped on purpose. */
export function countSettledQuickStartSteps(steps: readonly QuickStartStep[]): number {
  return steps.filter((step) => step.state === "done" || step.state === "skipped").length;
}

/** Every signal is in, so the guide has nothing left to say and stops rendering. */
export function isQuickStartComplete(steps: readonly QuickStartStep[]): boolean {
  return steps.every((step) => step.state === "done");
}

// ── Browser preferences ─────────────────────────────────────────────────────

const CHANGE_EVENT = "sdp:quick-start-updated";
const memory = new Map<string, QuickStartPrefs>();
const parsed = new Map<string, { raw: string | null; prefs: QuickStartPrefs }>();

export function quickStartKey(scope: DashboardCacheScope): string {
  return `sdp:quick-start:v2:${getDashboardCacheScopeKey(scope)}`;
}

// Stored in the browser, so each field is read on its own: one bad field falls back to its
// default without throwing away the others.
const storedPrefsSchema = z.object({
  dismissed: z.boolean().catch(false),
  collapsed: z.boolean().catch(false),
  sidebarCollapsed: z.boolean().catch(false),
  skipped: z.object({ custody: z.string().optional().catch(undefined) }).catch({}),
});

function parsePrefs(raw: string | null): QuickStartPrefs {
  if (!raw) return EMPTY_QUICK_START_PREFS;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return EMPTY_QUICK_START_PREFS;
  }
  const result = storedPrefsSchema.safeParse(json);
  if (!result.success) return EMPTY_QUICK_START_PREFS;
  const { skipped, ...flags } = result.data;
  return { ...flags, skipped: skipped.custody ? { custody: skipped.custody } : {} };
}

/**
 * The person's choices for this scope. Returns the same object until the stored value changes,
 * so it is safe as a `useSyncExternalStore` snapshot.
 */
export function readQuickStartPrefs(key: string): QuickStartPrefs {
  const remembered = memory.get(key);
  if (remembered) return remembered;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return EMPTY_QUICK_START_PREFS;
  }
  const cached = parsed.get(key);
  if (cached && cached.raw === raw) return cached.prefs;
  const prefs = parsePrefs(raw);
  parsed.set(key, { raw, prefs });
  return prefs;
}

function writePrefs(key: string, update: (current: QuickStartPrefs) => QuickStartPrefs): void {
  const next = update(readQuickStartPrefs(key));
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
    memory.delete(key);
  } catch {
    // The guide still works for this session when browser storage is unavailable.
    memory.set(key, next);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function dismissQuickStart(key: string): void {
  writePrefs(key, (current) => ({ ...current, dismissed: true }));
}

/** Brings a dismissed guide back, unfolded on both surfaces. */
export function resumeQuickStart(key: string): void {
  writePrefs(key, (current) => ({
    ...current,
    dismissed: false,
    collapsed: false,
    sidebarCollapsed: false,
  }));
}

export function setQuickStartCollapsed(
  key: string,
  surface: "overview" | "sidebar",
  collapsed: boolean
): void {
  writePrefs(key, (current) =>
    surface === "overview" ? { ...current, collapsed } : { ...current, sidebarCollapsed: collapsed }
  );
}

export function skipQuickStartStep(key: string, step: "custody", now = new Date()): void {
  writePrefs(key, (current) => ({
    ...current,
    skipped: { ...current.skipped, [step]: now.toISOString() },
  }));
}

const STATUS_STALE_EVENT = "sdp:quick-start-status-stale";

/**
 * Tells a mounted guide its server status is out of date, for flows that change it in this tab
 * (a key created, a wallet provisioned). The guide re-reads the status; nothing is written here.
 */
export function invalidateQuickStartStatus(): void {
  window.dispatchEvent(new Event(STATUS_STALE_EVENT));
}

/**
 * Records that a flow in this tab finished a quick start step, for whichever guide is on: the
 * Overview module's guide re-reads the server status, the previous design's guide advances its
 * stored step. Wallets and API keys run under either guide, so they never pick one themselves.
 *
 * @param flags - The dashboard's flags.
 * @param scope - The dashboard scope the previous design's guide is stored under.
 * @param step - The step the flow finished.
 */
export function recordQuickStartStep(
  flags: DesignFlags | null | undefined,
  scope: DashboardCacheScope,
  step: "api-key" | "wallet"
): void {
  if (isDesignModuleOn(flags, "overview")) {
    invalidateQuickStartStatus();
    return;
  }
  completeLegacyQuickStartStep(legacyQuickStartKey(scope), step);
}

export function subscribeQuickStartStatusStale(onStale: () => void): () => void {
  window.addEventListener(STATUS_STALE_EVENT, onStale);
  return () => window.removeEventListener(STATUS_STALE_EVENT, onStale);
}

export function subscribeQuickStart(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key) {
      memory.delete(event.key);
      parsed.delete(event.key);
    } else {
      memory.clear();
      parsed.clear();
    }
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
