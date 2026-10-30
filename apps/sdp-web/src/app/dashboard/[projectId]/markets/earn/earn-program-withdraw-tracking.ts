"use client";

import type { EarnPortfolioToken } from "@sdp/types/earn";
import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "@/lib/idempotency-key-store";
import { parseUnsignedDecimal } from "./earn-decimal";

/**
 * The custodial PROGRAM WITHDRAWAL idempotency key store — the vault
 * deposit/exit stores' sibling (`earn-vault-deposit-tracking.ts`,
 * `earn-vault-withdraw-tracking.ts`), sharing every durability rule through
 * `@/lib/idempotency-key-store.ts`: `sessionStorage` per tab, scoped to the
 * signed-in user and org, kept from the claim until an answer retires it.
 *
 * It replaces the modal's React-ref request id (the legacy body-`requestId`
 * contract): a ref dies with the modal and with the page load, so a reload
 * after an ambiguous first attempt — a 5xx, a lost answer — minted a FRESH id
 * and re-sent the same payout as a second one. The API derives the provider's
 * dedupe key from the caller key alone, so the key must outlive the component
 * to keep one intent on one payout. It also replaces the body form: the API
 * refuses a withdrawal that names BOTH a body `requestId` and the
 * `Idempotency-Key` header (it cannot tell which one a caller's retry keeps
 * stable), and the dashboard now keys every mutation it proxies — so the
 * caller's key travels as the header alone, the same wire shape the vault
 * deposit and exit clients use.
 */
export const programWithdrawalIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:earn:program-withdrawal:idempotency:v1"
);

/**
 * The idempotency key identifies ONE intended withdrawal, so it is bound to
 * the parameters that define it. Retrying an unchanged confirm reuses the key
 * (the provider collapses the duplicate instead of paying twice); changing the
 * amount, token, or destination after a failed attempt mints a new key, so a
 * corrected withdrawal can never be answered with the cached result of the
 * one the user just fixed — which would settle funds to the old address while
 * reporting success. "Changing the amount" means its VALUE: the signature is
 * canonical, so re-spelling the same value after an ambiguous failure replays
 * the original key instead of paying twice.
 */
export function withdrawalRequestSignature(
  programId: string,
  amountUsd: string,
  /** Absent until a payout lane exists; no submit is reachable before then. */
  token: EarnPortfolioToken | undefined,
  destinationAddress: string
): string {
  // "1.50", "1.5" and "01.50" are ONE intended withdrawal at three spellings.
  // Keying on the raw text would let a cosmetic edit after an ambiguous failure
  // — a 5xx that may already be recorded, the exact case
  // `answerRetiresKey` refuses to release a key on — mint a fresh
  // key and resubmit the same intent as a SECOND withdrawal. Canonicalizing
  // keeps every spelling of a value on one key while a real correction
  // ("12.50" → "13.00") still mints a new one. The fallback only ever sees
  // mid-typing input no submit accepts.
  const canonicalAmount = parseUnsignedDecimal(amountUsd)?.canonical ?? amountUsd;
  return JSON.stringify([programId, canonicalAmount, token, destinationAddress]);
}

/**
 * What makes two submissions the SAME program withdrawal: the PROJECT, the
 * program, the canonical amount, the payout token and the destination.
 *
 * The project is in here for the same replay-scope reason the vault stores'
 * fingerprints document: the key outlives the component, the dashboard's key
 * scope is per (user, org), and one organization can act on its program from
 * two projects — a second project re-submitting an identical-looking form
 * must mint its own key, never inherit the first project's held one.
 * `programId` is part of the inner signature because one modal instance can
 * be re-pointed at another program without unmounting: a key minted for a
 * withdrawal from program A must never be carried into an identical-looking
 * withdrawal from program B.
 */
export function programWithdrawalRequestFingerprint(input: {
  /** `null` only before a project resolves; it still discriminates. */
  projectId: string | null;
  programId: string;
  amountUsd: string;
  token: EarnPortfolioToken | undefined;
  destinationAddress: string;
}): string {
  return JSON.stringify([
    input.projectId,
    withdrawalRequestSignature(
      input.programId,
      input.amountUsd,
      input.token,
      input.destinationAddress
    ),
  ]);
}

/**
 * Test-only: clear the shared module-scope tiers so specs are
 * order-independent. Production never calls this.
 *
 * @internal
 */
export function resetProgramWithdrawalTrackingStateForTests(): void {
  resetIdempotencyKeyStoresForTests();
}
