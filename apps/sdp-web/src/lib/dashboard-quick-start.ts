import { advanceQuickStartProgress, type DashboardQuickStartStep } from "@sdp/types";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "./dashboard-cache-scope";

export type QuickStartStep = DashboardQuickStartStep;
const CHANGE_EVENT = "sdp:quick-start-updated";
const memory = new Map<string, QuickStartStep>();
const persistence = new Map<string, (step: QuickStartStep) => Promise<boolean>>();
const pendingSaves = new Map<string, Promise<unknown>>();
export type QuickStartPlacement = "modal" | "left" | "right" | "right-collapsed";
const placements = new Map<string, QuickStartPlacement>();

export function quickStartLayout(
  placement: QuickStartPlacement | null,
  pathname: string,
  docked: boolean,
  expanded: boolean
) {
  const isModal = (placement === "modal" && pathname === "/dashboard") || (docked && expanded);
  const isRight =
    docked ||
    placement === "right" ||
    placement === "right-collapsed" ||
    (placement === "modal" && !isModal);
  const isCollapsed = (placement === "left" || placement === "right-collapsed") && !expanded;
  return { isModal, isRight, isCollapsed };
}

export function readQuickStartPlacement(key: string): QuickStartPlacement {
  try {
    const value = placements.get(key) ?? window.localStorage.getItem(`${key}:placement`);
    return value === "left" || value === "right" || value === "right-collapsed" ? value : "modal";
  } catch {
    return placements.get(key) ?? "modal";
  }
}

export function setQuickStartPlacement(key: string, placement: QuickStartPlacement) {
  placements.set(key, placement);
  try {
    window.localStorage.setItem(`${key}:placement`, placement);
  } catch {
    /* Session fallback. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function initializeQuickStart(
  key: string,
  serverStep: QuickStartStep,
  save: (step: QuickStartStep) => Promise<boolean>
) {
  persistence.set(key, save);
  const local = readQuickStart(key);
  const resolved = advanceQuickStartProgress(local, serverStep);
  if (resolved !== local || resolved !== serverStep) setQuickStart(key, resolved);
}

export function quickStartKey(scope: DashboardCacheScope, projectId: string | null): string {
  return `sdp:quick-start:v1:${getDashboardCacheScopeKey(scope, { projectId })}`;
}

export function readQuickStart(key: string, serverStep?: QuickStartStep | null): QuickStartStep {
  let value: string | null | undefined;
  try {
    value = memory.get(key) ?? window.localStorage.getItem(key);
  } catch {
    value = memory.get(key);
  }
  return advanceQuickStartProgress(value, serverStep);
}

export function setQuickStart(key: string, step: QuickStartStep): void {
  memory.set(key, step);
  try {
    window.localStorage.setItem(key, step);
  } catch {
    // The guide still works for this session when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  const save = persistence.get(key);
  if (save) {
    // Serialize fast skips so an older response cannot overwrite later progress.
    const pending = (pendingSaves.get(key) ?? Promise.resolve()).then(() => save(step));
    pendingSaves.set(
      key,
      pending.catch(() => false)
    );
  }
}

export function completeQuickStartStep(key: string, completed: "api-key" | "wallet"): void {
  if (readQuickStart(key) === completed) {
    setQuickStart(key, completed === "api-key" ? "wallet" : "faucet");
  }
}

export function subscribeQuickStart(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key) memory.delete(event.key);
    else memory.clear();
    placements.clear();
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
