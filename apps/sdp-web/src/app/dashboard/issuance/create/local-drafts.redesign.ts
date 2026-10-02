"use client";

import { useSyncExternalStore } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import type { DraftState } from "./draft-model";

/** The access list a draft asked for; the flow keeps it apart from the API's allowlist flag. */
export type DraftAccess = "blocklist" | "allowlist" | "off";

/**
 * A draft the flow could not store in SDP yet, because the API takes only a complete draft:
 * kept in this browser until it is finished or discarded.
 */
export interface LocalDraft {
  id: string;
  savedAt: string;
  /** The step it was left on, 0-based. */
  step: number;
  access: DraftAccess;
  draft: DraftState;
}

const EMPTY: readonly LocalDraft[] = [];
const CHANGE_EVENT = "sdp:issuance-local-drafts-updated";
const memory = new Map<string, readonly LocalDraft[]>();
const parsed = new Map<string, { raw: string | null; drafts: readonly LocalDraft[] }>();

const ACCESS = new Set<DraftAccess>(["blocklist", "allowlist", "off"]);
const ASSET_CLASSES = new Set<string>(["stablecoin", "digital-asset"]);
const PEG_CURRENCIES = new Set<string>(["USD", "EUR", "GBP"]);

/**
 * Local drafts are per person, organization and project, as wallet pins are: a draft names the
 * project's wallets, so it never follows into a project that cannot see them.
 */
export function localDraftsKey(scope: DashboardCacheScope, projectId: string | null) {
  if (!projectId || !scope.orgId) return null;
  return `sdp:issuance-local-drafts:v1:${getDashboardCacheScopeKey(scope, { projectId })}`;
}

function isLocalDraft(value: unknown): value is LocalDraft {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LocalDraft>;
  return (
    typeof entry.id === "string" &&
    typeof entry.savedAt === "string" &&
    typeof entry.step === "number" &&
    ACCESS.has(entry.access as DraftAccess) &&
    Boolean(entry.draft) &&
    typeof entry.draft === "object"
  );
}

function parseDrafts(raw: string | null): readonly LocalDraft[] {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return EMPTY;
    const drafts = value.filter(isLocalDraft);
    return drafts.length > 0 ? drafts : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** The stored drafts, newest first; the same array until storage changes. */
export function readLocalDrafts(key: string): readonly LocalDraft[] {
  const remembered = memory.get(key);
  if (remembered) return remembered;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return EMPTY;
  }
  const cached = parsed.get(key);
  if (cached && cached.raw === raw) return cached.drafts;
  const drafts = parseDrafts(raw);
  parsed.set(key, { raw, drafts });
  return drafts;
}

function writeDrafts(key: string, next: readonly LocalDraft[]) {
  try {
    if (next.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(next));
    memory.delete(key);
  } catch {
    // Still kept for this session when browser storage is unavailable.
    memory.set(key, next);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Stores a draft, replacing the one with its id, and puts it first. */
export function saveLocalDraft(key: string, draft: LocalDraft) {
  writeDrafts(key, [draft, ...readLocalDrafts(key).filter((entry) => entry.id !== draft.id)]);
}

export function removeLocalDraft(key: string, id: string) {
  const current = readLocalDrafts(key);
  if (!current.some((entry) => entry.id === id)) return;
  writeDrafts(
    key,
    current.filter((entry) => entry.id !== id)
  );
}

function subscribe(onChange: () => void) {
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

/**
 * This project's drafts kept in the browser, with the key the mutators take (null without a
 * project). Empty on the server and the first client render.
 */
export function useLocalDrafts() {
  const { dashboardCacheScope, selectedProjectId } = useDashboardWorkspace();
  const storageKey = localDraftsKey(dashboardCacheScope, selectedProjectId);
  const drafts = useSyncExternalStore(
    subscribe,
    () => (storageKey ? readLocalDrafts(storageKey) : EMPTY),
    () => EMPTY
  );
  return { storageKey, drafts };
}

/**
 * A stored draft laid over a fresh one, field by field, so a draft saved by an older build
 * never hands the flow a value of the wrong type, and a key held by a wallet the project no
 * longer has falls back to the fresh draft's wallet.
 */
export function restoreDraft(
  fresh: DraftState,
  stored: unknown,
  walletIds: ReadonlySet<string>
): DraftState {
  const source = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const next = { ...fresh } as Record<string, unknown>;
  for (const [field, value] of Object.entries(fresh)) {
    if (field === "authorities") continue;
    const candidate = source[field];
    if (candidate !== undefined && typeof candidate === typeof value) next[field] = candidate;
  }
  if (!ASSET_CLASSES.has(next.assetClass as string)) next.assetClass = fresh.assetClass;
  if (PEG_CURRENCIES.has(source.pegCurrency as string)) next.pegCurrency = source.pegCurrency;
  const storedAuthorities = (
    source.authorities && typeof source.authorities === "object" ? source.authorities : {}
  ) as Record<string, unknown>;
  const authorities = { ...fresh.authorities };
  for (const role of Object.keys(authorities) as (keyof DraftState["authorities"])[]) {
    const walletId = storedAuthorities[role];
    if (typeof walletId === "string" && walletIds.has(walletId)) authorities[role] = walletId;
  }
  next.authorities = authorities;
  return next as DraftState;
}
