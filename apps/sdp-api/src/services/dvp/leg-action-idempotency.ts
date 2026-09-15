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
import { conflict } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * A pending key older than this belongs to a request that died before it could
 * record an answer. Far above the longest live request (a send plus two
 * 15-second confirmation waits), so a request in flight is never retaken.
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
 * The answer an earlier request with this key already gave, if any.
 *
 * @throws 409 when the key belongs to a different request, or to one still running.
 */
function answerFromExisting(
  existing: DvpLegActionRequest | null,
  fingerprint: string
): { kind: "replay"; result: DvpLegActionResult } | { kind: "retake"; id: string } {
  if (existing === null) {
    throw conflict("A request with this Idempotency-Key is still being processed; retry shortly");
  }
  if (existing.fingerprint !== fingerprint) {
    throw conflict("Idempotency key already used with different request payload");
  }
  if (existing.status === "sent") {
    return {
      kind: "replay",
      result: { signature: existing.signature, leg: existing.side, amount: existing.amount },
    };
  }
  if (Date.now() - Date.parse(existing.updatedAt) < ABANDONED_AFTER_MS) {
    throw conflict("A request with this Idempotency-Key is still being processed; retry shortly");
  }
  return { kind: "retake", id: existing.id };
}

/**
 * Runs a leg action at most once per Idempotency-Key.
 *
 * Without a key the action simply runs. With one: a sent key replays the stored
 * answer without touching the chain; a key held by a live request, or used for a
 * different request, is refused; otherwise the key is taken, the action runs,
 * and its answer is recorded. A request that throws releases the key so the
 * same key can try again, which is safe because a retry still has to get past
 * the leg lock and the live chain reads that stopped the first one.
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
  let id = `dvpla_${crypto.randomUUID().replace(/-/g, "")}`;
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
    const answer = answerFromExisting(reservation.existing, fingerprint);
    if (answer.kind === "replay") {
      return { result: answer.result, replayed: true };
    }
    const staleBefore = new Date(Date.now() - ABANDONED_AFTER_MS).toISOString();
    if (!(await requests.retakeAbandoned(answer.id, staleBefore))) {
      throw conflict("A request with this Idempotency-Key is still being processed; retry shortly");
    }
    id = answer.id;
  }

  let result: DvpLegActionResult;
  try {
    result = await run();
  } catch (error) {
    await requests.release(id);
    throw error;
  }
  await requests.markSent(id, { signature: result.signature, amount: result.amount });
  return { result, replayed: false };
}
