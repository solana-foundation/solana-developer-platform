/**
 * Idempotency-Key handling for funding or reclaiming one DvP leg.
 *
 * Both actions broadcast a transaction that moves tokens. A client retrying
 * after an ambiguous failure must get the first request's answer, not a second
 * send: the leg lock only stops two sends overlapping, and a retry that arrives
 * after the first confirmed (and after somebody deposited again) would pass
 * every chain check and move the new balance too.
 */

import { createHash } from "node:crypto";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresDvpLegActionRequestRepository,
  type DvpLegActionRequest,
} from "@/db/repositories/dvp-leg-action-request.repository";
import { AppError, conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

/**
 * A pending key older than this belongs to a request that ended without
 * recording its outcome. Far above the longest live request (a send plus two
 * 15-second confirmation waits), so a request in flight is never mistaken for one.
 */
const ABANDONED_AFTER_MS = 5 * 60 * 1_000;

export interface DvpLegActionResult {
  signature: Signature;
  leg: "a" | "b";
  amount: string;
}

export interface DvpLegActionRequestScope {
  action: "fund" | "reclaim";
  tradeId: string;
  side: "a" | "b";
  organizationId: string;
  projectId: string;
  /** The custody wallet the action resolved to sign with. */
  custodyWalletId: string;
}

/**
 * Hashes everything that makes two requests the same one. The resolved wallet is
 * part of it, so a key replayed by a caller who resolves a different wallet is
 * refused rather than answered with somebody else's signature.
 */
function fingerprintOf(scope: DvpLegActionRequestScope): string {
  const material = [scope.action, scope.tradeId, scope.side, scope.custodyWalletId];
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/**
 * The answer an earlier request with this key already gave.
 *
 * A pending key is never handed to a new request. Its first request may have
 * moved the leg and then failed to record that (a crash, a failed write), and
 * running again under the same key could move it a second time, after a reclaim
 * confirmed and somebody deposited again. Refusing is the only safe reading: the
 * caller checks the trade and, if it still wants the action, sends a new key.
 *
 * @throws 409 when the key belongs to a different request, is still running, or
 *   never recorded what it did.
 */
function answerFromExisting(
  existing: DvpLegActionRequest | null,
  fingerprint: string
): DvpLegActionResult {
  if (existing === null) {
    throw conflict("A request with this Idempotency-Key is still being processed; retry shortly");
  }
  if (existing.fingerprint !== fingerprint) {
    throw conflict("Idempotency key already used with different request payload");
  }
  if (existing.status === "sent") {
    return { signature: existing.signature, leg: existing.side, amount: existing.amount };
  }
  if (Date.now() - Date.parse(existing.updatedAt) < ABANDONED_AFTER_MS) {
    throw conflict("A request with this Idempotency-Key is still being processed; retry shortly");
  }
  throw conflict(
    "A request with this Idempotency-Key did not record its outcome. Check the trade, then send a new key if the action is still needed."
  );
}

/**
 * Whether a failed request provably sent nothing, so its key can be reused.
 *
 * Every refusal fund and reclaim make is an AppError with a 4xx status raised
 * before broadcast, and a preflight rejection is mapped to one too. Anything else
 * (a transient RPC failure, an ambiguous send, a failed write after the send) may
 * have moved the leg, so the key stays taken.
 */
function sentNothing(error: unknown): boolean {
  return error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500;
}

/**
 * Runs a leg action at most once per Idempotency-Key.
 *
 * Without a key the action simply runs. With one: a sent key replays the stored
 * answer without touching the chain; any other taken key is refused; otherwise
 * the key is taken, the action runs, and its answer is recorded. A refusal that
 * sent nothing frees the key for another try. Any other failure keeps it taken,
 * because the leg may have moved.
 *
 * @param env - API environment.
 * @param idempotencyKey - The caller's header, or null.
 * @param scope - What the request asks for, and for whom.
 * @param run - The action itself.
 * @returns The action's answer, replayed or fresh, and whether it was replayed.
 */
export async function runDvpLegActionOnce(
  env: Env,
  idempotencyKey: string | null,
  scope: DvpLegActionRequestScope,
  run: () => Promise<DvpLegActionResult>
): Promise<{ result: DvpLegActionResult; replayed: boolean }> {
  if (idempotencyKey === null) {
    return { result: await run(), replayed: false };
  }

  const requests = createPostgresDvpLegActionRequestRepository(getDb(env));
  const fingerprint = fingerprintOf(scope);
  const id = `dvpla_${crypto.randomUUID().replace(/-/g, "")}`;
  const reservation = await requests.reserve({
    id,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    idempotencyKey,
    fingerprint,
    action: scope.action,
    tradeId: scope.tradeId,
    side: scope.side,
  });
  if (!reservation.reserved) {
    return { result: answerFromExisting(reservation.existing, fingerprint), replayed: true };
  }

  let result: DvpLegActionResult;
  try {
    result = await run();
  } catch (error) {
    if (sentNothing(error)) {
      await requests.release(id);
    }
    throw error;
  }
  try {
    await requests.markSent(id, { signature: result.signature, amount: result.amount });
  } catch (error) {
    // The leg moved; failing the request now would report a failure that did
    // not happen. The key stays pending, which a retry reads as an unrecorded
    // outcome and refuses, so it cannot move the leg again.
    getLogger().error(
      { error, idempotencyRequestId: id, signature: result.signature },
      "dvp leg action: sent, but the idempotency record could not be marked sent"
    );
  }
  return { result, replayed: false };
}
