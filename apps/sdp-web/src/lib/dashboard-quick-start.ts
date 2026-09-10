import { type DashboardCacheScope, getDashboardCacheScopeKey } from "./dashboard-cache-scope";

const QUICK_START_STEPS = ["api-key", "wallet", "faucet", "done"] as const;
export type QuickStartStep = (typeof QUICK_START_STEPS)[number];
const CHANGE_EVENT = "sdp:quick-start-updated";
const memory = new Map<string, QuickStartStep>();

function advanceQuickStartProgress(...steps: unknown[]): QuickStartStep {
  const ranks: readonly unknown[] = QUICK_START_STEPS;
  return QUICK_START_STEPS[Math.max(0, ...steps.map((step) => ranks.indexOf(step)))];
}

export function quickStartKey(scope: DashboardCacheScope): string {
  return `sdp:quick-start:v1:${getDashboardCacheScopeKey(scope)}`;
}

export function readQuickStart(key: string, serverStep?: QuickStartStep | null): QuickStartStep {
  let value: string | null | undefined;
  try {
    value = window.localStorage.getItem(key);
  } catch {
    value = memory.get(key);
  }
  return advanceQuickStartProgress(memory.get(key), value, serverStep);
}

export function setQuickStart(key: string, step: QuickStartStep): void {
  const nextStep = advanceQuickStartProgress(readQuickStart(key), step);
  memory.set(key, nextStep);
  try {
    window.localStorage.setItem(key, nextStep);
  } catch {
    // The guide still works for this session when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function completeQuickStartStep(key: string, completed: "api-key" | "wallet"): void {
  if (completed === "wallet") {
    setQuickStart(key, "done");
  } else if (readQuickStart(key) === completed) {
    setQuickStart(key, "wallet");
  }
}

export function subscribeQuickStart(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key) memory.delete(event.key);
    else memory.clear();
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
