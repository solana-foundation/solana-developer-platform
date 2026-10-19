"use client";

import { useSyncExternalStore } from "react";
import { z } from "zod";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import type { DraftState } from "./draft-model";

/** The access list a draft asked for; the flow keeps it apart from the API's allowlist flag. */
export type DraftAccess = "blocklist" | "allowlist" | "off";

/**
 * What the browser holds of a draft: each field read on its own, so a value of the wrong type
 * (from an older build, say) drops out and the fresh draft's value stands. A half-finished draft
 * is normal here, so the draft's own validation (a name, a symbol) does not apply.
 */
const optionalText = z.string().optional().catch(undefined);
const optionalFlag = z.boolean().optional().catch(undefined);
const storedDraftSchema = z.object({
  assetClass: z.enum(["stablecoin", "digital-asset"]).optional().catch(undefined),
  name: optionalText,
  symbol: optionalText,
  description: optionalText,
  website: optionalText,
  maxSupply: optionalText,
  decimals: optionalText,
  allowlist: optionalFlag,
  pauseTransfers: optionalFlag,
  interestBearing: optionalFlag,
  interestRate: optionalText,
  transferFee: optionalFlag,
  transferFeeBasisPoints: optionalText,
  transferFeeMax: optionalText,
  issuerName: optionalText,
  pegCurrency: z.enum(["USD", "EUR", "GBP"]).optional().catch(undefined),
  freezeAccounts: optionalFlag,
  permanentDelegate: optionalFlag,
  authorities: z
    .object({
      "mint-authority": optionalText,
      "metadata-authority": optionalText,
      "freeze-authority": optionalText,
      "permanent-delegate": optionalText,
    })
    .catch({}),
});
export type StoredDraft = z.infer<typeof storedDraftSchema>;

/** Reads a stored draft's fields one by one; anything that is not an object reads as empty. */
export function parseStoredDraft(value: unknown): StoredDraft {
  return storedDraftSchema.catch({ authorities: {} }).parse(value);
}

const storedLocalDraftSchema = z.object({
  id: z.string(),
  savedAt: z.string(),
  /** The step it was left on, 0-based. */
  step: z.number(),
  access: z.enum(["blocklist", "allowlist", "off"]),
  draft: storedDraftSchema,
});

/**
 * A draft the flow could not store in SDP yet, because the API takes only a complete draft:
 * kept in this browser until it is finished or discarded.
 */
export type LocalDraft = z.infer<typeof storedLocalDraftSchema>;

const EMPTY: readonly LocalDraft[] = [];
const CHANGE_EVENT = "sdp:issuance-local-drafts-updated";
const memory = new Map<string, readonly LocalDraft[]>();
const parsed = new Map<string, { raw: string | null; drafts: readonly LocalDraft[] }>();

/**
 * Local drafts are per person, organization and project, as wallet pins are: a draft names the
 * project's wallets, so it never follows into a project that cannot see them.
 */
export function localDraftsKey(scope: DashboardCacheScope, projectId: string | null) {
  if (!projectId || !scope.orgId) return null;
  return `sdp:issuance-local-drafts:v1:${getDashboardCacheScopeKey(scope, { projectId })}`;
}

function parseDrafts(raw: string | null): readonly LocalDraft[] {
  if (!raw) return EMPTY;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  const list = z.array(z.unknown()).safeParse(json);
  if (!list.success) return EMPTY;
  const drafts = list.data.flatMap((entry) => {
    const parsedEntry = storedLocalDraftSchema.safeParse(entry);
    return parsedEntry.success ? [parsedEntry.data] : [];
  });
  return drafts.length > 0 ? drafts : EMPTY;
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
  stored: StoredDraft,
  walletIds: ReadonlySet<string>
): DraftState {
  const { authorities: storedAuthorities, ...fields } = stored;
  const authorities = { ...fresh.authorities };
  for (const role of Object.keys(authorities) as (keyof DraftState["authorities"])[]) {
    const walletId = storedAuthorities[role];
    if (walletId !== undefined && walletIds.has(walletId)) authorities[role] = walletId;
  }
  return { ...fresh, ...withoutUndefined(fields), authorities };
}

function withoutUndefined(fields: Omit<StoredDraft, "authorities">): Partial<DraftState> {
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
}
