import { type DashboardCacheScope, getDashboardCacheScopeKey } from "./dashboard-cache-scope";

const QUICK_START_STEPS = ["api-key", "wallet", "faucet", "done"] as const;
export type QuickStartStep = (typeof QUICK_START_STEPS)[number];
const CHANGE_EVENT = "sdp:quick-start-updated";
const memory = new Map<string, QuickStartStep>();
const progressWriteFailures = new Set<string>();
const dismissedMemory = new Map<string, boolean>();

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
    value = progressWriteFailures.has(key) ? memory.get(key) : window.localStorage.getItem(key);
  } catch {
    value = memory.get(key);
  }
  return advanceQuickStartProgress(memory.get(key), value, serverStep);
}

function writeProgress(key: string, step: QuickStartStep): void {
  memory.set(key, step);
  try {
    window.localStorage.setItem(key, step);
    progressWriteFailures.delete(key);
  } catch {
    // The guide still works for this session when browser storage is unavailable.
    progressWriteFailures.add(key);
  }
}

export function setQuickStart(key: string, step: QuickStartStep): void {
  writeProgress(key, advanceQuickStartProgress(readQuickStart(key), step));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function isQuickStartDismissed(key: string): boolean {
  try {
    return dismissedMemory.get(key) ?? window.localStorage.getItem(`${key}:dismissed`) === "true";
  } catch {
    return dismissedMemory.get(key) ?? false;
  }
}

function setDismissed(key: string, dismissed: boolean): void {
  dismissedMemory.set(key, dismissed);
  try {
    window.localStorage.setItem(`${key}:dismissed`, String(dismissed));
  } catch {
    // Keep dismissal and resume available when browser storage is blocked.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function dismissQuickStart(key: string): void {
  setDismissed(key, true);
}

export function resumeQuickStart(key: string): void {
  if (readQuickStart(key) === "done") {
    // Older previews stored dismissal as "done". Explicitly restarting from
    // Settings also supports those users without reopening the guide on load.
    writeProgress(key, "api-key");
  }
  setDismissed(key, false);
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
    if (event.key) {
      memory.delete(event.key);
      progressWriteFailures.delete(event.key);
      if (event.key.endsWith(":dismissed")) {
        dismissedMemory.delete(event.key.slice(0, -":dismissed".length));
      }
    } else {
      memory.clear();
      progressWriteFailures.clear();
      dismissedMemory.clear();
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
