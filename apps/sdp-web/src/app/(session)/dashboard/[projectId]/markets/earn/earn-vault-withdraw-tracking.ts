"use client";

import { z } from "zod";

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
 * fingerprint. The identity that build serialized was
 * `[projectId, positionId, shares, toleranceBps, redemptionMode?]` — the
 * DERIVED shares where this build keeps the typed quantity, no format tag —
 * so the identity itself carries the shares the first attempt went out with,
 * which is what makes an exact replay of that attempt possible. Parsed by
 * schema (saved input is external input), never by hand; the two tuple shapes
 * that build could write collapse to one record.
 */
type LegacyWithdrawalIdentity = {
  projectId: string | null;
  positionId: string;
  redemptionMode: "standard" | "instant" | undefined;
  shares: string;
  toleranceBps: number | null;
};

const legacyIdentitySchema = z.union([
  z
    .tuple([
      z.union([z.string(), z.null()]),
      z.string().min(1),
      z.string().min(1),
      z.union([z.number(), z.null()]),
    ])
    .transform(
      ([projectId, positionId, shares, toleranceBps]): LegacyWithdrawalIdentity => ({
        projectId,
        positionId,
        redemptionMode: undefined,
        shares,
        toleranceBps,
      })
    ),
  z
    .tuple([
      z.union([z.string(), z.null()]),
      z.string().min(1),
      z.string().min(1),
      z.union([z.number(), z.null()]),
      z.enum(["standard", "instant"]),
    ])
    .transform(
      ([
        projectId,
        positionId,
        shares,
        toleranceBps,
        redemptionMode,
      ]): LegacyWithdrawalIdentity => ({
        projectId,
        positionId,
        redemptionMode,
        shares,
        toleranceBps,
      })
    ),
]);

function legacyWithdrawalIdentity(fingerprint: string): LegacyWithdrawalIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fingerprint);
  } catch {
    return undefined;
  }
  // This build's own entries lead with the format tag, which no legacy
  // identity could — the previous build led with the project. The tag check
  // runs before the schema so a this-build entry under a different typed
  // amount is refused even where its shape would parse.
  if (Array.isArray(parsed) && parsed[0] === FINGERPRINT_FORMAT) return undefined;
  const candidate = legacyIdentitySchema.safeParse(parsed);
  return candidate.success ? candidate.data : undefined;
}

/**
 * What adopting the previous build's unresolved attempt means concretely: the
 * key's legacy fingerprint, the shares parsed out of that identity, and the
 * floor the attempt was minted with, from the floor memo — `null` when it
 * deliberately sent none, `undefined` when the memo LOST it, which makes the
 * attempt unreplayable exactly (the caller must neither adopt it nor mint a
 * fresh key over it).
 */
export type VaultWithdrawalRecovery = {
  fingerprint: string;
  floor: string | null | undefined;
  shares: string;
};

/**
 * The PREVIOUS build's unresolved attempt on this exit, if one is kept — the
 * upgrade bridge for the fingerprint change above. A kept entry is an attempt
 * that may already have executed and was never answered; submitting this
 * exit without adopting it would mint a second key and can exit AGAIN. The
 * caller replays the adopted attempt's OWN request instead: its key (the
 * store answers `claim` under the legacy fingerprint), its shares, and its
 * minted floor. Whichever way the API answers, it answers the FIRST attempt,
 * and the answer retires the legacy key.
 *
 * The adoption is a DECISION the caller surfaces for review before it sends —
 * the recovered shares and floor are exactly what a confirm will submit, and
 * they are generally NOT the amount the form is showing (see the modals'
 * recovery notice). The OLDEST match comes back first (see `keptEntries`):
 * several legacy attempts can be kept at once — "raise the tolerance and
 * retry" minted a fresh key in the previous build too — and each adopted
 * replay resolves one, oldest first, until none is left and typed-quantity
 * keys flow normally. Only the project, position, and redemption mode must
 * match: the typed quantity cannot be compared across the two builds
 * (dollars against shares, at a rate neither recorded), and the tolerance
 * cannot either — the replay carries the legacy attempt's own minted floor,
 * whatever tolerance it came from. `undefined` when nothing legacy is kept.
 */
export function recallLegacyVaultWithdrawalKeptKey(input: {
  redemptionMode?: "standard" | "instant";
  projectId: string | null;
  positionId: string;
}): VaultWithdrawalRecovery | undefined {
  for (const entry of vaultWithdrawalIdempotencyKeyStore.keptEntries()) {
    const legacy = legacyWithdrawalIdentity(entry.fingerprint);
    if (!legacy) continue;
    if (legacy.projectId !== input.projectId || legacy.positionId !== input.positionId) continue;
    if (legacy.redemptionMode !== input.redemptionMode) continue;
    return {
      fingerprint: entry.fingerprint,
      floor: vaultWithdrawalFloorMemo.recall(entry.fingerprint),
      shares: legacy.shares,
    };
  }
  return undefined;
}

/**
 * Which kept key a withdrawal submission runs under, decided ONCE at submit:
 * the recovery the review surfaced (an ADOPTED previous-build attempt — the
 * submit then runs under the legacy fingerprint and replays that attempt
 * exactly, its own key, shares, and minted floor, so the API answers the
 * first attempt either way), or the typed-quantity fingerprint's own kept
 * key. `adoptedShares` is set for an adoption only — the shares the caller
 * must send instead of any fresh derivation, because the first attempt's
 * body, verbatim, is the only request the legacy key may carry.
 *
 * The adoption only stands while the recovered key is STILL kept. When it is
 * gone — its own answer arrived between the mount-time snapshot and this
 * confirm (a replay sent from a previous visit, retired late) — the
 * resolution reports `recoverySpent` and resolves to NOTHING sendable: the
 * confirm was approved as a REPLAY of that attempt, so turning it into a
 * fresh typed submission would be the second exit the adoption exists to
 * prevent. The caller stops, refreshes its recovery (the re-scan finds
 * nothing kept), and the next confirm — re-reviewed, notice gone — is a
 * normal typed-quantity submission.
 */
export function resolveVaultWithdrawalKeptKey(input: {
  fingerprint: string;
  recovery?: VaultWithdrawalRecovery | undefined;
}): { adoptedShares?: string; fingerprint: string; recoverySpent?: boolean; reused: boolean } {
  const recovery = input.recovery;
  if (recovery) {
    if (!vaultWithdrawalIdempotencyKeyStore.has(recovery.fingerprint)) {
      return { fingerprint: recovery.fingerprint, recoverySpent: true, reused: true };
    }
    if (recovery.floor === undefined) {
      // The recovered attempt's floor was lost, so its key cannot be replayed
      // exactly — and a fresh key over it is the double exit. The reuse
      // resolves to nothing sendable: the caller stops on the missing shares.
      return { fingerprint: recovery.fingerprint, reused: true };
    }
    return {
      adoptedShares: recovery.shares,
      fingerprint: recovery.fingerprint,
      reused: true,
    };
  }
  return {
    fingerprint: input.fingerprint,
    reused: vaultWithdrawalIdempotencyKeyStore.has(input.fingerprint),
  };
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
