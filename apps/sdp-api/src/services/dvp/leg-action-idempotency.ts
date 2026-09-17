/**
 * Idempotency-Key handling for one DvP action: funding or reclaiming a leg, or
 * the settle/cancel that closes a trade (PRO-1993).
 *
 * Every one of them broadcasts a transaction that moves tokens. A client
 * retrying after an ambiguous failure must get the first request's answer, not
 * a second send. Neither lock on its own can give that:
 *
 * - The leg lock stops two sends overlapping, but a retry arriving after the
 *   first confirmed (and after somebody deposited again) would pass every chain
 *   check and move the new balance too.
 * - The close lock (PRO-1973) is taken after the blockhash and the authority
 *   signature, so a retry while it is live is refused with 409 and never learns
 *   the signature that did close the trade, and a retry after it expired on a
 *   close that DID land signs and sponsors a second one against an escrow the
 *   chain has already emptied.
 *
 * The transaction a request is about to send is written onto its pending row
 * before broadcast. Whatever happens after (a crash, a lost response, a failed
 * write), a retry asks the chain what that transaction did and answers from it.
 * That question is the same for every action, so one classifier answers it:
 * past its last valid block height a transaction can never land, and only
 * `confirmed` or better is believed.
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

/** What a close answers with. It moves both legs, so it reports no amount. */
export interface DvpCloseActionResult {
  signature: Signature;
  /** Whether this request saw the close confirm. A replay only ever replays a landed one. */
  landed: boolean;
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

export interface DvpCloseRequestScope {
  action: "settle" | "cancel";
  tradeId: string;
  organizationId: string;
  projectId: string;
  /** The settlement wallet the close signs with. */
  custodyWalletId: string;
}

/** Without a key there is nothing to record against. */
const recordNothing: RecordDvpLegActionAttempt = async () => {};

/**
 * Hashes everything that makes two requests the same one. The resolved wallet is
 * part of it, so a key replayed by a caller who resolves a different wallet is
 * refused rather than answered with somebody else's signature. A close has no
 * side to include, and its action never equals a leg action's, so the two
 * cannot collide.
 */
function fingerprintOf(scope: DvpLegActionRequestScope | DvpCloseRequestScope): string {
  const material =
    "side" in scope
      ? [scope.action, scope.tradeId, scope.side, scope.custodyWalletId]
      : [scope.action, scope.tradeId, scope.custodyWalletId];
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

/**
 * Either the recorded answer to replay, or the row this request now owns. The
 * attempt is handed back as recorded; each action maps it to its own response,
 * so neither has to understand the other's shape.
 */
type Resolution =
  | { kind: "replay"; side: "a" | "b" | null; attempt: DvpLegActionAttempt }
  | { kind: "run"; id: string };

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
    return { kind: "replay", side: existing.side, attempt: existing.attempt };
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
    return { kind: "replay", side: existing.side, attempt: existing.attempt };
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
  return runDvpActionOnce(env, idempotencyKey, scope, {
    run,
    replay: (side, attempt) => {
      // 0112's CHECK keeps a leg action's amount alongside its signature, so a
      // row missing one is a broken record, not a replayable answer.
      if (side === null || attempt.amount === null) {
        throw new Error("a recorded leg action is missing its side or amount");
      }
      return { signature: attempt.signature, leg: side, amount: attempt.amount };
    },
    releaseOnError: sentNothing,
  });
}

/**
 * Runs a settle or cancel at most once per Idempotency-Key.
 *
 * Same contract as a leg action, with one difference in when the key is freed.
 * The leg path frees it on any 4xx, on the documented premise that every leg
 * refusal is raised before broadcast. A close breaks that premise: a close that
 * WAS broadcast and then failed on chain throws 400 `dvp_close_failed_on_chain`
 * (`settle.ts` closeOutcome). Freeing on the error code would happen to be
 * right there, because a confirmed failure moved nothing, but it would rest on
 * knowing which 4xx are post-broadcast.
 *
 * So the close frees its key on evidence instead: only when nothing was ever
 * recorded, which means nothing was signed and nothing was sent. Once a
 * transaction is on the row the key is kept, and the next retry asks the chain
 * what it did. A confirmed failure classifies as `moved_nothing`, the retry
 * retakes the row and runs, so the same end state is reached from the chain's
 * answer rather than from an error code.
 *
 * @param env - API environment.
 * @param idempotencyKey - The caller's header, or null.
 * @param scope - Which close, on which trade, signed by which wallet.
 * @param run - The close, given the hook it must call before broadcast.
 * @returns The close's answer, replayed or fresh, and whether it was replayed.
 */
export async function runDvpCloseOnce(
  env: Env,
  idempotencyKey: string | null,
  scope: DvpCloseRequestScope,
  run: (recordAttempt: RecordDvpLegActionAttempt) => Promise<DvpCloseActionResult>
): Promise<{ result: DvpCloseActionResult; replayed: boolean }> {
  return runDvpActionOnce(env, idempotencyKey, scope, {
    run,
    replay: (_side, attempt) => ({ signature: attempt.signature, landed: true }),
    releaseOnError: (_error, recorded) => !recorded,
    // A close the request could not confirm is NOT the answer to replay. Marking
    // it sent would let the next retry read it back as a landed close, and the
    // handler records a landed close as a settled or cancelled trade: an
    // unconfirmed broadcast would become a terminal state nothing verified.
    // Left pending, the attempt stays on the row and the retry asks the chain,
    // which is the only thing that knows. Once it answers `landed` the row is
    // marked sent and replayed as confirmed.
    markSent: (result) => result.landed,
  });
}

/**
 * The machinery both actions share: take the key, resolve one somebody else
 * holds, run the action with the hook that records its transaction, mark the
 * answer.
 *
 * @param env - API environment.
 * @param idempotencyKey - The caller's header, or null.
 * @param scope - What the request asks for, and for whom.
 * @param handlers - How to replay a recorded attempt, when to free the key on a
 *   failure, and the action itself.
 * @returns The action's answer, replayed or fresh, and whether it was replayed.
 */
async function runDvpActionOnce<TResult extends { signature: Signature }>(
  env: Env,
  idempotencyKey: string | null,
  scope: DvpLegActionRequestScope | DvpCloseRequestScope,
  handlers: {
    run: (recordAttempt: RecordDvpLegActionAttempt) => Promise<TResult>;
    replay: (side: "a" | "b" | null, attempt: DvpLegActionAttempt) => TResult;
    /** Whether a failure proves nothing was sent, so the key can be reused. */
    releaseOnError: (error: unknown, recorded: boolean) => boolean;
    /**
     * Whether this answer is the one a retry should be given. Defaults to true;
     * a close overrides it, because an unconfirmed broadcast is not an answer.
     */
    markSent?: (result: TResult) => boolean;
  }
): Promise<{ result: TResult; replayed: boolean }> {
  if (idempotencyKey === null) {
    return { result: await handlers.run(recordNothing), replayed: false };
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
    side: "side" in scope ? scope.side : null,
  });
  if (!reservation.reserved) {
    const resolution = await resolveExisting(env, requests, reservation.existing, fingerprint);
    if (resolution.kind === "replay") {
      return { result: handlers.replay(resolution.side, resolution.attempt), replayed: true };
    }
    id = resolution.id;
  }

  const heldId = id;
  let recorded = false;
  let result: TResult;
  try {
    result = await handlers.run(async (attempt) => {
      // Before broadcast, and fatal if it fails: a send nothing recorded is
      // exactly the one a retry could not resolve.
      if (!(await requests.recordAttempt(heldId, attempt))) {
        throw new Error("the idempotency record was taken over before the transaction was sent");
      }
      recorded = true;
    });
  } catch (error) {
    if (handlers.releaseOnError(error, recorded)) {
      await requests.release(heldId);
    }
    throw error;
  }

  if (handlers.markSent !== undefined && !handlers.markSent(result)) {
    // Deliberately left pending with its attempt on the row; the next retry
    // resolves it from the chain rather than replaying an unverified answer.
    return { result, replayed: false };
  }

  try {
    if (!(await requests.markSent(heldId))) {
      throw new Error("the action returned without recording the transaction it sent");
    }
  } catch (error) {
    // The money moved; failing the request now would report a failure that did
    // not happen. The attempt is on the row, so a retry resolves it from the chain.
    getLogger().error(
      { error, idempotencyRequestId: heldId, signature: result.signature },
      "dvp action: sent, but the idempotency record could not be marked sent"
    );
  }
  return { result, replayed: false };
}
