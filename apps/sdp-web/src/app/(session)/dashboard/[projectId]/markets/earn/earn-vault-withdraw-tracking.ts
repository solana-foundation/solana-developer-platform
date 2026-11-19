"use client";

import {
  createFloorMemo,
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "@/lib/idempotency-key-store";

/**
 * The vault WITHDRAWAL idempotency key store — the deposit store's mirror
 * (PRO-1702), sharing every durability rule through
 * `@/lib/idempotency-key-store.ts`. A retry inside the record-before-broadcast
 * window must carry the same key or the chain accepts the same exit twice.
 */
export const vaultWithdrawalIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:earn:vault-withdrawal:idempotency:v1"
);

/**
 * Test-only: clear the shared module-scope tiers so specs are
 * order-independent. Production never calls this.
 *
 * @internal
 */
export function resetVaultWithdrawalTrackingStateForTests(): void {
  resetIdempotencyKeyStoresForTests();
  vaultWithdrawalFloorMemo.resetForTests();
  vaultWithdrawalSharesMemo.resetForTests();
}

/**
 * What makes two submissions the SAME exit: the PROJECT, the position, the
 * user's TYPED quantity, and the user's slippage tolerance. Change any one and
 * it is a different withdrawal, not a retry. The position carries the vault
 * and the signing wallet transitively — a holding is one (org, environment,
 * provider, vault, wallet) claim — so naming it is naming both, and the
 * project is here for the same replay-scope reason the deposit fingerprint
 * documents.
 *
 * The TYPED quantity — the dollar amount an atomic exit starts from, the
 * shares a provider order starts from — is in here in place of the share
 * intent the API receives, for the same reason the tolerance is in here in
 * place of the floor: the fingerprint must be reproducible from user input
 * while a key stays held. An atomic exit DERIVES its shares from the live
 * position value, which the positions polls re-read every few seconds — a
 * fingerprint on the derived shares drifts under a kept key, the retry misses
 * it, mints a SECOND key, and that submit can exit again while the first
 * attempt may already have executed. The typed quantity is stable across
 * every poll. The derived shares the key actually went out with are
 * remembered SEPARATELY (`rememberVaultWithdrawalShares`) and replayed
 * verbatim, because the API's own idempotency fingerprint includes `shares`
 * and refuses a replay whose body changed — exactly the refusal that retires
 * the key and unlocks the second exit above.
 *
 * Renaming the fingerprint's terms orphans the entries the PREVIOUS build
 * wrote under the same store key: they are keyed on the derived shares, so
 * no fingerprint this build computes can ever find them again, and a retry
 * of such an attempt would mint a second key — the double exit above, one
 * upgrade later. The identity therefore LEADS with a format tag
 * ({@link FINGERPRINT_FORMAT}), which makes the two builds' entries tellable
 * apart, and {@link recallLegacyVaultWithdrawalKeptKey} is the compatible
 * recovery path: the submit adopts the previous build's unresolved attempt
 * and replays it exactly instead of minting over it.
 */
export function vaultWithdrawalRequestFingerprint(input: {
  redemptionMode?: "standard" | "instant";
  /** `null` only before a project resolves; it still discriminates. */
  projectId: string | null;
  positionId: string;
  /**
   * What the customer typed: the dollar amount for an atomic exit, the exact
   * shares for a provider order — canonicalized, so a re-entry finds the key.
   */
  quantity: string;
  /**
   * The USER'S slippage tolerance, or `null` when the provider takes no
   * derived floor — never the derived floor itself, for the reason the
   * deposit fingerprint documents: the fingerprint must be reproducible from
   * user input after a reload, and a quote-derived floor is not. "Raise the
   * tolerance and retry" still mints a fresh key. The floor a HELD key was
   * minted with is remembered separately (`rememberVaultWithdrawalFloor`) and
   * replayed verbatim, because the API's own fingerprint includes
   * `minAmountOut` and refuses a replay whose floor changed.
   */
  toleranceBps: number | null;
}): string {
  const identity = [
    FINGERPRINT_FORMAT,
    input.projectId,
    input.positionId,
    input.quantity,
    input.toleranceBps,
  ];
  if (input.redemptionMode !== undefined) identity.push(input.redemptionMode);
  return JSON.stringify(identity);
}

/**
 * The withdrawal fingerprint's FORMAT tag, leading every identity this build
 * writes. The previous build's identities lead with the project instead — a
 * `projectId` can never equal this tag, and the legacy scan refuses any entry
 * that does lead with it, so a kept key this build minted under a different
 * typed amount is never mistaken for a legacy one.
 */
const FINGERPRINT_FORMAT = "typed-quantity-1";

/**
 * One kept entry the PREVIOUS build wrote, parsed back out of its stored
 * fingerprint: the identity that build serialized was
 * `[projectId, positionId, shares, toleranceBps, redemptionMode?]` — the
 * DERIVED shares where this build keeps the typed quantity, no tag — so the
 * identity itself carries the shares the first attempt went out with, which
 * is what makes an exact replay of that attempt possible. `undefined` for an
 * entry this build wrote (it leads with the format tag) or could not have
 * written.
 */
type LegacyWithdrawalIdentity = {
  projectId: string | null;
  positionId: string;
  redemptionMode?: "standard" | "instant";
  shares: string;
};

function legacyWithdrawalIdentity(fingerprint: string): LegacyWithdrawalIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fingerprint);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  if (parsed[0] === FINGERPRINT_FORMAT) return undefined;
  if (parsed.length !== 4 && parsed.length !== 5) return undefined;
  const [projectId, positionId, shares, toleranceBps, redemptionMode] = parsed;
  if (projectId !== null && typeof projectId !== "string") return undefined;
  if (typeof positionId !== "string" || typeof shares !== "string" || shares === "") {
    return undefined;
  }
  if (toleranceBps !== null && typeof toleranceBps !== "number") return undefined;
  if (parsed.length === 5) {
    if (redemptionMode !== "standard" && redemptionMode !== "instant") return undefined;
    return { projectId, positionId, redemptionMode, shares };
  }
  return { projectId, positionId, shares };
}

/**
 * The PREVIOUS build's unresolved attempt on this exit, if one is kept — the
 * upgrade bridge for the fingerprint change above. A kept entry is an attempt
 * that may already have executed and was never answered; submitting this
 * exit without adopting it would mint a second key and can exit AGAIN. The
 * caller replays the adopted attempt's OWN request instead: its key (the
 * store answers `claim` under the legacy fingerprint), its shares (parsed
 * from the legacy identity), and the floor the floor memo still holds under
 * the legacy fingerprint. Whichever way the API answers, it answers the
 * FIRST attempt, and the answer retires the legacy key.
 *
 * The OLDEST match comes back first (see `keptEntries`): several legacy
 * attempts can be kept at once — "raise the tolerance and retry" minted a
 * fresh key in the previous build too — and each submit resolves one, oldest
 * first, until none is left and typed-quantity keys flow normally. Only the
 * project, position, and redemption mode must match: the typed quantity
 * cannot be compared across the two builds (dollars against shares, at a
 * rate neither recorded), and the tolerance cannot either — the replay
 * carries the legacy attempt's own minted floor, whatever tolerance it came
 * from. `undefined` when nothing legacy is kept: the caller submits under
 * its own fingerprint as usual.
 */
export function recallLegacyVaultWithdrawalKeptKey(input: {
  redemptionMode?: "standard" | "instant";
  projectId: string | null;
  positionId: string;
}): { fingerprint: string; shares: string } | undefined {
  for (const entry of vaultWithdrawalIdempotencyKeyStore.keptEntries()) {
    const legacy = legacyWithdrawalIdentity(entry.fingerprint);
    if (!legacy) continue;
    if (legacy.projectId !== input.projectId || legacy.positionId !== input.positionId) continue;
    if (legacy.redemptionMode !== input.redemptionMode) continue;
    return { fingerprint: entry.fingerprint, shares: legacy.shares };
  }
  return undefined;
}

/**
 * Which kept key a withdrawal submission runs under, decided ONCE at submit:
 * the typed-quantity fingerprint's own kept key, or — when no entry answers
 * to it — the previous build's unresolved attempt on this position, ADOPTED
 * ({@link recallLegacyVaultWithdrawalKeptKey}) so the submit replays that
 * attempt exactly under its legacy fingerprint instead of minting a second
 * key over it. `adoptedShares` is set for an adoption only: the shares parsed
 * out of the legacy identity, which the caller must send instead of any fresh
 * derivation — the first attempt's body, verbatim, is the only request the
 * legacy key may carry.
 */
export function resolveVaultWithdrawalKeptKey(input: {
  fingerprint: string;
  redemptionMode?: "standard" | "instant";
  projectId: string | null;
  positionId: string;
}): { fingerprint: string; reused: boolean; adoptedShares?: string } {
  if (vaultWithdrawalIdempotencyKeyStore.has(input.fingerprint)) {
    return { fingerprint: input.fingerprint, reused: true };
  }
  const legacy = recallLegacyVaultWithdrawalKeptKey(input);
  if (!legacy) return { fingerprint: input.fingerprint, reused: false };
  return { fingerprint: legacy.fingerprint, reused: true, adoptedShares: legacy.shares };
}

/** The exit twin of the deposit's floor memo — see `createFloorMemo`. */
const vaultWithdrawalFloorMemo = createFloorMemo("sdp:earn:vault-withdrawal:floor:v1");

/** Record the floor `fingerprint`'s key is being submitted with. */
export function rememberVaultWithdrawalFloor(
  fingerprint: string,
  minAmountOut: string | null
): void {
  vaultWithdrawalFloorMemo.remember(fingerprint, minAmountOut);
}

/** The remembered floor, `null` for "deliberately none", `undefined` for nothing. */
export function recallVaultWithdrawalFloor(fingerprint: string): string | null | undefined {
  return vaultWithdrawalFloorMemo.recall(fingerprint);
}

/**
 * The share intent each kept fingerprint's key was MINTED with — the same
 * story as the floor memo beside it: an atomic exit's shares are DERIVED from
 * the live position value, so they cannot be re-derived reliably when a kept
 * key's retry comes back, and the API's fingerprint pins `shares` anyway. A
 * provider order's shares are its typed input, so only the atomic path
 * depends on this memo — but recording what actually went out, always, keeps
 * the replay honest by construction.
 */
const vaultWithdrawalSharesMemo = createFloorMemo("sdp:earn:vault-withdrawal:shares:v1");

/** Record the share intent `fingerprint`'s key is being submitted with. */
export function rememberVaultWithdrawalShares(fingerprint: string, shares: string): void {
  vaultWithdrawalSharesMemo.remember(fingerprint, shares);
}

/** The remembered share intent, or `undefined` when nothing is remembered. */
export function recallVaultWithdrawalShares(fingerprint: string): string | null | undefined {
  return vaultWithdrawalSharesMemo.recall(fingerprint);
}

/**
 * Drop a retired key's shares so the next fresh derivation cannot inherit it,
 * only once no key is kept for the fingerprint (see `forgetVaultDepositFloor`).
 */
export function forgetVaultWithdrawalShares(fingerprint: string): void {
  if (vaultWithdrawalIdempotencyKeyStore.has(fingerprint)) return;
  vaultWithdrawalSharesMemo.forget(fingerprint);
}

/**
 * Drop a retired key's floor so the next fresh derivation cannot inherit it,
 * only once no key is kept for the fingerprint (see `forgetVaultDepositFloor`).
 */
export function forgetVaultWithdrawalFloor(fingerprint: string): void {
  if (vaultWithdrawalIdempotencyKeyStore.has(fingerprint)) return;
  vaultWithdrawalFloorMemo.forget(fingerprint);
}
