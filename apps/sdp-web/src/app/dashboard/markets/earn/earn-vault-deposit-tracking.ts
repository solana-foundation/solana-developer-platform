"use client";

import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "./earn-idempotency-key-store";

/**
 * The vault DEPOSIT idempotency key store (PRO-1692).
 *
 * All of the machinery — the per-tab `sessionStorage` tier, the in-memory
 * fallback, the quota-divergence handling, the approval-hold pinning, the
 * expiring-entry bound — lives in `earn-idempotency-key-store.ts`, shared with
 * the withdrawal flow. This module owns the two things that make a DEPOSIT a
 * deposit: its versioned storage key (which existing tabs already hold data
 * under — never change it casually) and what makes two submissions the SAME
 * request.
 */
export const vaultDepositIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:earn:vault-deposit:idempotency:v1"
);

/**
 * Test-only: clear the shared module-scope tiers so specs are
 * order-independent. Production never calls this.
 *
 * @internal
 */
export function resetVaultDepositTrackingStateForTests(): void {
  resetIdempotencyKeyStoresForTests();
  memoryFloorMemo = {};
  try {
    window.sessionStorage.removeItem(FLOOR_MEMO_STORAGE_KEY);
  } catch {
    // No storage in this environment; the memory tier above is already clear.
  }
}

/**
 * What makes two submissions the SAME request: the PROJECT, the strategy, the
 * wallet paying for it, and the amount. Change any one and it is a different
 * deposit, not a retry — which is exactly the distinction an idempotency key
 * has to encode.
 *
 * The project is in here for a reason that only shows up once the key is
 * durable. A custody config may be ORGANIZATION-level, so two projects can
 * resolve the same `custody_wallets` row; without the project, switching
 * project in one tab and re-submitting the same strategy and amount reuses the
 * first project's key. The API's replay lookup is keyed on
 * `(organization_id, request_id)`, so that reused key resolves the FIRST
 * project's movement — returning it as a replay instead of making the deposit.
 * A ref-scoped key never survived a project switch, so this only became
 * reachable when the key started outliving the component.
 */
export function vaultDepositRequestFingerprint(input: {
  /** `null` only before a project resolves; it still discriminates. */
  projectId: string | null;
  strategyId: string;
  custodyWalletId: string;
  amount: string;
  /**
   * The USER'S slippage tolerance, or `null` when the provider takes no
   * derived floor — never the derived floor itself. The fingerprint must be
   * reproducible from what the user can re-enter after a reload, or the
   * store's cross-reload guarantee is fiction: a quote-derived floor moves
   * with the live rate (a vesting-yield vault re-interpolates on every read),
   * so fingerprinting it makes a mid-flight reload miss the held entry and
   * mint a SECOND key for one intent. The tolerance is stable across
   * re-quotes and still changes on "raise the tolerance and retry" after a
   * slippage refusal, which is the property the floor was carrying.
   *
   * The floor the key was actually minted with is remembered SEPARATELY
   * (`rememberVaultDepositFloor`) and replayed verbatim for a held key,
   * because the API's own idempotency fingerprint includes `minSharesOut` and
   * refuses a replay whose floor changed.
   */
  toleranceBps: number | null;
}): string {
  return JSON.stringify([
    input.projectId,
    input.strategyId,
    input.custodyWalletId,
    input.amount,
    input.toleranceBps,
  ]);
}

/**
 * The share floor each in-flight fingerprint's key was minted with (see
 * `toleranceBps` above for why it cannot live in the fingerprint). Same
 * per-tab tier as the key store: `sessionStorage` so it survives the reload
 * the held key survives, an in-memory fallback when storage is refused, and a
 * hard bound so an abandoned tab cannot grow it without limit.
 */
const FLOOR_MEMO_STORAGE_KEY = "sdp:earn:vault-deposit:floor:v1";
const FLOOR_MEMO_BOUND = 32;

type FloorMemo = Record<string, string | null>;

let memoryFloorMemo: FloorMemo = {};

function readFloorMemo(): FloorMemo {
  try {
    const raw = window.sessionStorage.getItem(FLOOR_MEMO_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const memo: FloorMemo = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || value === null) memo[key] = value;
    }
    return memo;
  } catch {
    return { ...memoryFloorMemo };
  }
}

function writeFloorMemo(memo: FloorMemo): void {
  memoryFloorMemo = { ...memo };
  try {
    window.sessionStorage.setItem(FLOOR_MEMO_STORAGE_KEY, JSON.stringify(memo));
  } catch {
    // The in-memory copy above still serves this component's lifetime.
  }
}

/** Record the floor `fingerprint`'s key is being submitted with (insertion-bounded). */
export function rememberVaultDepositFloor(fingerprint: string, minSharesOut: string | null): void {
  const memo = readFloorMemo();
  delete memo[fingerprint];
  memo[fingerprint] = minSharesOut;
  const keys = Object.keys(memo);
  for (const stale of keys.slice(0, Math.max(0, keys.length - FLOOR_MEMO_BOUND))) {
    delete memo[stale];
  }
  writeFloorMemo(memo);
}

/**
 * The floor `fingerprint`'s key was minted with: a string floor, `null` for
 * "deliberately none", or `undefined` when nothing is remembered (evicted, a
 * different tab, or storage refused) — the caller then falls back to a fresh
 * derivation and the server's own fingerprint remains the last line.
 */
export function recallVaultDepositFloor(fingerprint: string): string | null | undefined {
  const memo = readFloorMemo();
  return fingerprint in memo ? memo[fingerprint] : undefined;
}

/** Drop a retired key's floor so the next fresh derivation cannot inherit it. */
export function forgetVaultDepositFloor(fingerprint: string): void {
  const memo = readFloorMemo();
  delete memo[fingerprint];
  writeFloorMemo(memo);
}

export function claimVaultDepositIdempotencyKey(fingerprint: string): string {
  return vaultDepositIdempotencyKeyStore.claim(fingerprint);
}

export function holdVaultDepositIdempotencyKey(fingerprint: string): void {
  vaultDepositIdempotencyKeyStore.hold(fingerprint);
}

export function isVaultDepositIdempotencyKeyHeld(fingerprint: string): boolean {
  return vaultDepositIdempotencyKeyStore.isHeld(fingerprint);
}

export function releaseVaultDepositIdempotencyKey(fingerprint: string): void {
  vaultDepositIdempotencyKeyStore.release(fingerprint);
}
