/**
 * Idempotency-Key handling for funding or reclaiming one DvP leg.
 *
 * Both actions broadcast a transaction that moves tokens. A client retrying
 * after an ambiguous failure must get the first request's answer, not a second
 * send: the leg lock only stops two sends overlapping, and a retry that arrives
 * after the first confirmed (and after somebody deposited again) would pass
 * every chain check and move the new balance too.
 *
 * The transaction a request is about to send is written onto its pending row
 * before broadcast. Whatever happens after (a crash, a lost response, a failed
 * write), a retry asks the chain what that transaction did and answers from it.
 */

import { createHash } from "node:crypto";
import { createRpc } from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresDvpLegActionRequestRepository,
  type DvpLegActionAttempt,
  type DvpLegActionRequest,
  type DvpLegActionRequestRepository,
} from "@/db/repositories/dvp-leg-action-request.repository";
import { AppError, conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { readDvpFundingReceipt } from "./funding-receipt";

export type { DvpLegActionAttempt };

/**
 * A pending key with no recorded attempt, older than this, belongs to a request
 * that died before it signed anything, so nothing was sent. Far above the time a
 * live request takes to reach its signature, so a request in flight is never
 * taken over.
 */
const ABANDONED_AFTER_MS = 5 * 60 * 1_000;

const STILL_RUNNING = "A request with this Idempotency-Key is still being processed; retry shortly";

export interface DvpLegActionResult {
  signature: Signature;
  leg: "a" | "b";
  amount: string;
}

/** Called by the action with its signed transaction, before it is broadcast. */
export type RecordDvpLegActionAttempt = (attempt: DvpLegActionAttempt) => Promise<void>;

export interface DvpLegActionRequestScope {
  action: "fund" | "reclaim";
  tradeId: string;
  side: "a" | "b";
  organizationId: string;
  projectId: string;
  /** The custody wallet the action resolved to sign with. */
  custodyWalletId: string;
}

/** Without a key there is nothing to record against. */
const recordNothing: RecordDvpLegActionAttempt = async () => {};

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
 * Whether a failed request provably sent nothing, so its key can be reused.
 *
 * Every refusal fund and reclaim make is an AppError with a 4xx status raised
 * before broadcast, and a preflight rejection is mapped to one too. Anything
 * else may have moved the leg, and the recorded attempt decides on the next try.
 */
function sentNothing(error: unknown): boolean {
  return error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500;
}

type Resolution = { kind: "replay"; result: DvpLegActionResult } | { kind: "run"; id: string };

function replayOf(side: "a" | "b", attempt: DvpLegActionAttempt): Resolution {
  return {
    kind: "replay",
    result: { signature: attempt.signature, leg: side, amount: attempt.amount },
  };
}

/**
 * Resolves a key another request already holds: replays its answer, or hands the
 * row over when nothing was sent.
 *
 * @throws 409 for a different request, a request still running, or a sent
 *   transaction that can still land.
 */
async function resolveExisting(
  env: Env,
  requests: DvpLegActionRequestRepository,
  existing: DvpLegActionRequest | null,
  fingerprint: string
): Promise<Resolution> {
  if (existing === null) {
    throw conflict(STILL_RUNNING);
  }
  if (existing.fingerprint !== fingerprint) {
    throw conflict("Idempotency key already used with different request payload");
  }
  if (existing.status === "sent") {
    return replayOf(existing.side, existing.attempt);
  }

  const staleBefore = new Date(Date.now() - ABANDONED_AFTER_MS).toISOString();
  if (existing.attempt === null) {
    // Nothing signed: either still on its way to a signature, or it died first.
    if (
      Date.parse(existing.updatedAt) >= Date.parse(staleBefore) ||
      !(await requests.retake(existing.id, null, staleBefore))
    ) {
      throw conflict(STILL_RUNNING);
    }
    return { kind: "run", id: existing.id };
  }

  const outcome = await readDvpFundingReceipt(createRpc(env), {
    fundingTx: existing.attempt.signature,
    expiryHeight: existing.attempt.expiryHeight,
  });
  if (outcome === "pending") {
    throw conflict(STILL_RUNNING);
  }
  if (outcome === "landed") {
    // It went out and landed; only the record of that was lost.
    await requests.markSent(existing.id);
    return replayOf(existing.side, existing.attempt);
  }
  // Failed on chain, or expired unseen: nothing moved, so the action may run.
  if (!(await requests.retake(existing.id, existing.attempt.signature, staleBefore))) {
    throw conflict(STILL_RUNNING);
  }
  return { kind: "run", id: existing.id };
}

/**
 * Runs a leg action at most once per Idempotency-Key.
 *
 * Without a key the action simply runs. With one: a sent key replays the stored
 * answer; a key held by a request still running, or used for a different
 * request, is refused; otherwise the key is taken, the action records its
 * transaction before sending it, and its answer is marked sent. A refusal that
 * sent nothing frees the key. Any other failure keeps it, and the next try with
 * that key asks the chain what the recorded transaction did.
 *
 * @param env - API environment.
 * @param idempotencyKey - The caller's header, or null.
 * @param scope - What the request asks for, and for whom.
 * @param run - The action, given the hook it must call before broadcast.
 * @returns The action's answer, replayed or fresh, and whether it was replayed.
 */
export async function runDvpLegActionOnce(
  env: Env,
  idempotencyKey: string | null,
  scope: DvpLegActionRequestScope,
  run: (recordAttempt: RecordDvpLegActionAttempt) => Promise<DvpLegActionResult>
): Promise<{ result: DvpLegActionResult; replayed: boolean }> {
  if (idempotencyKey === null) {
    return { result: await run(recordNothing), replayed: false };
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
    const resolution = await resolveExisting(env, requests, reservation.existing, fingerprint);
    if (resolution.kind === "replay") {
      return { result: resolution.result, replayed: true };
    }
    id = resolution.id;
  }

  const heldId = id;
  let result: DvpLegActionResult;
  try {
    result = await run(async (attempt) => {
      // Before broadcast, and fatal if it fails: a send nothing recorded is
      // exactly the one a retry could not resolve.
      if (!(await requests.recordAttempt(heldId, attempt))) {
        throw new Error("the idempotency record was taken over before the transaction was sent");
      }
    });
  } catch (error) {
    if (sentNothing(error)) {
      await requests.release(heldId);
    }
    throw error;
  }

  try {
    if (!(await requests.markSent(heldId))) {
      throw new Error("the action returned without recording the transaction it sent");
    }
  } catch (error) {
    // The leg moved; failing the request now would report a failure that did
    // not happen. The attempt is on the row, so a retry resolves it from the chain.
    getLogger().error(
      { error, idempotencyRequestId: heldId, signature: result.signature },
      "dvp leg action: sent, but the idempotency record could not be marked sent"
    );
  }
  return { result, replayed: false };
}
