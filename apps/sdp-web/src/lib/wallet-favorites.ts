import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";

/**
 * A wallet pinned to the sidebar. The name and provider are copied in when the wallet is starred
 * (and refreshed whenever the Wallets page lists it), so the sidebar can show the pin on every
 * page without reading the wallet list.
 */
export interface WalletFavorite {
  walletId: string;
  name: string;
  provider: string | null;
}

export const EMPTY_WALLET_FAVORITES: readonly WalletFavorite[] = [];

const CHANGE_EVENT = "sdp:wallet-favorites-updated";
const ADDED_EVENT = "sdp:wallet-favorite-added";
const memory = new Map<string, readonly WalletFavorite[]>();
const parsed = new Map<string, { raw: string | null; favorites: readonly WalletFavorite[] }>();

/**
 * Favorites are per person, organization and project: wallets belong to a project, so a pin
 * from one project never points at a wallet the next one cannot open. Null without a project.
 */
export function walletFavoritesKey(
  scope: DashboardCacheScope,
  projectId: string | null
): string | null {
  if (!projectId || !scope.orgId) return null;
  return `sdp:wallet-favorites:v1:${getDashboardCacheScopeKey(scope, { projectId })}`;
}

function isFavorite(value: unknown): value is WalletFavorite {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WalletFavorite>;
  return (
    typeof candidate.walletId === "string" &&
    candidate.walletId.length > 0 &&
    typeof candidate.name === "string" &&
    (candidate.provider === null || typeof candidate.provider === "string")
  );
}

function parseFavorites(raw: string | null): readonly WalletFavorite[] {
  if (!raw) return EMPTY_WALLET_FAVORITES;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return EMPTY_WALLET_FAVORITES;
    const seen = new Set<string>();
    const favorites = value.filter((entry): entry is WalletFavorite => {
      if (!isFavorite(entry) || seen.has(entry.walletId)) return false;
      seen.add(entry.walletId);
      return true;
    });
    return favorites.length > 0 ? favorites : EMPTY_WALLET_FAVORITES;
  } catch {
    return EMPTY_WALLET_FAVORITES;
  }
}

/**
 * The pinned wallets for this scope, in the order they were starred. Returns the same array
 * until the stored value changes, so it is safe as a `useSyncExternalStore` snapshot.
 */
export function readWalletFavorites(key: string): readonly WalletFavorite[] {
  const remembered = memory.get(key);
  if (remembered) return remembered;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return EMPTY_WALLET_FAVORITES;
  }
  const cached = parsed.get(key);
  if (cached && cached.raw === raw) return cached.favorites;
  const favorites = parseFavorites(raw);
  parsed.set(key, { raw, favorites });
  return favorites;
}

function writeFavorites(key: string, next: readonly WalletFavorite[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
    memory.delete(key);
  } catch {
    // Pins still work for this session when browser storage is unavailable.
    memory.set(key, next);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Pins a wallet at the end of the list; pinning one already there changes nothing. */
export function addWalletFavorite(key: string, favorite: WalletFavorite): void {
  const current = readWalletFavorites(key);
  if (current.some((entry) => entry.walletId === favorite.walletId)) return;
  writeFavorites(key, [...current, favorite]);
  window.dispatchEvent(new CustomEvent(ADDED_EVENT, { detail: favorite.walletId }));
}

export function removeWalletFavorite(key: string, walletId: string): void {
  const current = readWalletFavorites(key);
  if (!current.some((entry) => entry.walletId === walletId)) return;
  writeFavorites(
    key,
    current.filter((entry) => entry.walletId !== walletId)
  );
}

/** Puts back an earlier list exactly, order included: what Undo does. */
export function restoreWalletFavorites(key: string, favorites: readonly WalletFavorite[]): void {
  writeFavorites(key, favorites);
}

/**
 * Brings the pins in line with a wallet list the page just read: a renamed wallet takes its new
 * name, and a wallet that no longer exists in the project drops out. Writes only on a change,
 * so calling it on every render of the list is cheap.
 */
export function syncWalletFavorites(key: string, wallets: readonly WalletFavorite[]): void {
  const current = readWalletFavorites(key);
  if (current.length === 0) return;
  const byId = new Map(wallets.map((wallet) => [wallet.walletId, wallet]));
  const next = current.flatMap((entry) => {
    const wallet = byId.get(entry.walletId);
    return wallet ? [{ ...entry, name: wallet.name, provider: wallet.provider }] : [];
  });
  const changed =
    next.length !== current.length ||
    next.some(
      (entry, index) =>
        entry.name !== current[index]?.name || entry.provider !== current[index]?.provider
    );
  if (changed) writeFavorites(key, next);
}

export function subscribeWalletFavorites(onChange: () => void): () => void {
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

/** Fires when a wallet is pinned in this tab, so the sidebar can open its Wallets group. */
export function subscribeWalletFavoriteAdded(onAdded: (walletId: string) => void): () => void {
  const listener = (event: Event) => {
    const walletId = (event as CustomEvent<unknown>).detail;
    if (typeof walletId === "string") onAdded(walletId);
  };
  window.addEventListener(ADDED_EVENT, listener);
  return () => window.removeEventListener(ADDED_EVENT, listener);
}
