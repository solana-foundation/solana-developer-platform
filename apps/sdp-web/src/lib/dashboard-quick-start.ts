import type { CustodyProvider, OrganizationRpcProvider } from "@sdp/types";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "./dashboard-cache-scope";

/**
 * What the server knows about an organization's setup: the RPC provider it saved, the custody
 * provider it connected, and whether any of its keys has signed a request yet. Read once per
 * page load by the dashboard layout and refreshed while the guide is on screen.
 */
export interface QuickStartStatus {
  /** The saved provider; null (or "default") means the managed SDP RPC. */
  rpcProvider: OrganizationRpcProvider | null;
  custodyProvider: CustodyProvider | null;
  apiKeyCount: number;
  /** When a key last signed a request; null until the first one arrives. */
  lastCallAt: string | null;
}

/**
 * One probe of the organization's RPC through the dashboard's test route. "unreachable" is our
 * request failing (quota, network), not the node answering badly, so it never reads as a failure.
 */
export interface RpcProbeResult {
  outcome: "ok" | "upstream_error" | "unreachable";
  /** The node's HTTP status, when it answered. */
  status: number | null;
  /** The provider the relay resolved, when it answered. */
  provider: string | null;
  checkedAt: string;
}

export const QUICK_START_STEP_IDS = ["rpc", "custody", "first-call"] as const;
export type QuickStartStepId = (typeof QUICK_START_STEP_IDS)[number];

/**
 * - done: the signal is in (a probe answered, a provider is connected, a call arrived).
 * - skipped: the person chose to leave it; only custody can be skipped.
 * - pending: waiting on the person, or on a probe we could not run.
 * - checking: the first probe has not answered yet.
 * - failing: the node answered with an error.
 */
export type QuickStartStepState = "done" | "skipped" | "pending" | "checking" | "failing";

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
}) as QuickStartPrefs;

/**
 * Resolves each step from what the server and the probe report plus what the person chose.
 *
 * @param input.status - The server's setup status.
 * @param input.probe - The latest RPC probe, or null before the first one answers.
 * @param input.skipped - Steps the person skipped.
 * @returns The three steps in order.
 */
export function resolveQuickStartSteps({
  status,
  probe,
  skipped,
}: {
  status: QuickStartStatus;
  probe: RpcProbeResult | null;
  skipped: QuickStartPrefs["skipped"];
}): QuickStartStep[] {
  const rpc: QuickStartStepState =
    probe === null
      ? "checking"
      : probe.outcome === "ok"
        ? "done"
        : probe.outcome === "upstream_error"
          ? "failing"
          : "pending";
  const custody: QuickStartStepState = status.custodyProvider
    ? "done"
    : skipped.custody
      ? "skipped"
      : "pending";
  const firstCall: QuickStartStepState = status.lastCallAt ? "done" : "pending";
  return [
    { id: "rpc", state: rpc },
    { id: "custody", state: custody },
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

function parsePrefs(raw: string | null): QuickStartPrefs {
  if (!raw) return EMPTY_QUICK_START_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<QuickStartPrefs> | null;
    if (!value || typeof value !== "object") return EMPTY_QUICK_START_PREFS;
    const skippedCustody = value.skipped?.custody;
    return {
      dismissed: value.dismissed === true,
      collapsed: value.collapsed === true,
      sidebarCollapsed: value.sidebarCollapsed === true,
      skipped: typeof skippedCustody === "string" ? { custody: skippedCustody } : {},
    };
  } catch {
    return EMPTY_QUICK_START_PREFS;
  }
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
