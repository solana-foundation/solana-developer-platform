"use client";

import type { EarnPortfolioToken } from "@sdp/types/earn";
import { storageFingerprint } from "@/lib/idempotency";
import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";
import { parseUnsignedDecimal } from "./earn-decimal";

/**
 * The custodial-program WITHDRAWAL idempotency key store — the vault deposit
 * and exit stores' sibling, sharing every durability rule through
 * `@/lib/idempotency-key-store.ts`. A retry after an ambiguous failure (a 5xx
 * that may already be recorded, a lost answer) must carry the same key or the
 * provider pays the same intent a second time. A React ref cannot do that
 * job: it dies with the modal and with the tab's page load, and a remount
 * would mint a fresh key for an intent that may already be paying out.
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
 * canonical (see below), so re-spelling the same value after an ambiguous
 * failure replays the original key instead of paying twice.
 *
 * `programId` is part of the signature because one modal instance can be
 * re-pointed at another program without unmounting. Without it, a key minted
 * for a withdrawal from program A would be carried into an identical-looking
 * withdrawal from program B.
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
  // — a 5xx that may already be recorded, the exact case `answerRetiresKey`
  // refuses to release a key on — mint a fresh key and resubmit the same
  // intent as a SECOND withdrawal. Canonicalizing keeps every spelling of a
  // value on one key while a real correction ("12.50" → "13.00") still mints
  // a new one. The fallback only ever sees mid-typing input no submit accepts.
  const canonicalAmount = parseUnsignedDecimal(amountUsd)?.canonical ?? amountUsd;
  return JSON.stringify([programId, canonicalAmount, token, destinationAddress]);
}

/**
 * What makes two submissions the SAME withdrawal, as the store's entry id: the
 * project plus the canonical signature above, hashed so the destination
 * address — the payer's counterparty — never sits in `sessionStorage` in the
 * clear, the same reason the per-action layer hashes its material
 * (`storageFingerprint`). The project is in here for the reason the vault
 * fingerprints name: the key outlives the component and the API's replay
 * lookup is org-scoped, so a key minted under one project must never resolve
 * another project's identical-looking withdrawal as its replay. The signature
 * rides as one JSON string element, so the compound stays collision-free.
 */
export function programWithdrawalRequestFingerprint(input: {
  /** `null` only before a project resolves; it still discriminates. */
  projectId: string | null;
  programId: string;
  amountUsd: string;
  token: EarnPortfolioToken | undefined;
  destinationAddress: string;
}): string {
  return storageFingerprint(
    JSON.stringify([
      input.projectId,
      withdrawalRequestSignature(
        input.programId,
        input.amountUsd,
        input.token,
        input.destinationAddress
      ),
    ])
  );
}
